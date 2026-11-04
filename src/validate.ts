/**
 * 面板写入前的服务条目校验。所有值重新构造成白名单字段,未知键一律丢弃;
 * 命令与参数只作为 argv 交给 Supervisor,从不经过 shell。
 * id 由服务端按 name 生成,创建时不接受用户输入;更新时不可改。
 */
import { serviceIdFor } from './entry.ts';
import { ServiceError } from './errors.ts';
import { ENV_NAME_RE } from './secrets.ts';
import { SERVICE_TYPES } from './panel.ts';
import type { ServiceConfigSection, ServiceEntry, ServiceType } from './types.ts';

const MAX_NAME = 120;
const MAX_ENDPOINT = 2048;
const MAX_PATH = 2048;
const MAX_ARGS = 8192;
const MAX_TOKEN_NAME = 128;
const MAX_MODEL = 200;
const MAX_MODELS = 200;
const MAX_OPTIONS_BYTES = 64 * 1024;
/** 已知模型任务；拼错时不静默变成无人接的条目。 */
const SERVICE_TASKS = new Set(['tts', 'sing', 'systemone', 'embeddings', 'rerank']);

function invalid(message: string, param?: string): ServiceError {
  return ServiceError.invalid(message, param);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 传输层不会带换行,这里挡住直接调用与粘进来的控制字符。 */
function noControl(value: string, field: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${field} must not contain control characters`, field);
  }
  return value;
}

function textOf(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${field} is required`, field);
    return undefined;
  }
  if (typeof value !== 'string') throw invalid(`${field} must be a string`, field);
  const text = value.trim();
  if (!text) {
    if (required) throw invalid(`${field} is required`, field);
    return undefined;
  }
  if ([...text].length > max) throw invalid(`${field} must be at most ${max} characters`, field);
  return noControl(text, field);
}

function keptText(
  raw: Record<string, unknown>,
  key: string,
  current: string | undefined,
  field: string,
  max: number,
): string | undefined {
  return key in raw ? textOf(raw[key], field, max) : current;
}

function flag(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  if (!(key in raw) || raw[key] === undefined) return fallback;
  const value = raw[key];
  if (typeof value !== 'boolean') throw invalid(`${key} must be a boolean`, key);
  return value;
}

function typeOf(value: unknown): ServiceType {
  if (typeof value === 'string' && (SERVICE_TYPES as readonly string[]).includes(value)) {
    return value as ServiceType;
  }
  throw invalid(`type must be one of ${SERVICE_TYPES.join(', ')}`, 'type');
}

/** 必需的 http/https URL;无协议时按 http 补全,路径保留。 */
function endpointOf(value: unknown): string {
  const text = textOf(value, 'endpoint', MAX_ENDPOINT, true)!;
  let url: URL;
  try {
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`);
  } catch {
    throw invalid('endpoint must be an http(s) URL', 'endpoint');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('endpoint must be an http(s) URL', 'endpoint');
  }
  if (url.username || url.password) {
    throw invalid('endpoint must not embed credentials', 'endpoint');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function envNameOf(value: unknown): string | undefined {
  const name = textOf(value, 'secretName', MAX_TOKEN_NAME);
  if (name === undefined) return undefined;
  if (!ENV_NAME_RE.test(name)) {
    throw invalid(`secretName "${name}" is not an environment variable name`, 'secretName');
  }
  return name;
}

function stringListOf(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of strings`, field);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid(`${field} must be an array of strings`, field);
    const text = item.trim();
    if (!text) continue;
    if (text.length > MAX_MODEL) {
      throw invalid(`${field} entries must be at most ${MAX_MODEL} characters`, field);
    }
    out.push(noControl(text, field));
    if (out.length > MAX_MODELS) throw invalid(`${field} must have at most ${MAX_MODELS} entries`, field);
  }
  return out;
}

/** JSON 对象:挡住原型链键,丢掉 undefined,限制体积。 */
function jsonObjectOf(
  value: unknown,
  field: string,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw invalid(`${field} must be a JSON object`, field);
  assertSafeJson(value, field);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw invalid(`${field} must be JSON-serializable`, field);
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) throw invalid(`${field} must be at most ${maxBytes} bytes`, field);
  return JSON.parse(text) as Record<string, unknown>;
}

function assertSafeJson(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, field);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw invalid(`${field} contains a forbidden key: ${key}`, field);
    }
    assertSafeJson(item, field);
  }
}

/**
 * 把面板给的一条对象归一成 ServiceEntry。`base` 存在时是部分更新:
 * 缺省字段沿用旧值,`null` / 空串清掉可选字段;id 不可改。
 * 创建时忽略传入的 id,按 name 生成一个待用的 id;面板路径会用
 * `serviceIdFor` 结合现有条目再算一次。
 */
export function normalizeEntry(input: unknown, base?: ServiceEntry): ServiceEntry {
  if (!isPlainObject(input)) throw invalid('service must be a JSON object', 'service');

  if (base && input.id !== undefined) {
    if (typeof input.id !== 'string' || input.id.trim() !== base.id) {
      throw invalid('id cannot be changed; remove the entry and add a new one', 'id');
    }
  }

  const name = textOf(
    'name' in input ? input.name : base?.name,
    'name',
    MAX_NAME,
    true,
  )!;
  const type = input.type === undefined && base ? base.type : typeOf(input.type ?? 'custom');
  const endpoint = input.endpoint === undefined && base
    ? base.endpoint
    : endpointOf(input.endpoint);

  const entry: ServiceEntry = {
    id: base?.id ?? serviceIdFor(name, type),
    name,
    type,
    enabled: flag(input, 'enabled', base?.enabled ?? true),
    endpoint,
    // systemone 是外部 Jev 端点；本地 StartLux 用 llamacpp 条目。创建时默认不托管。
    manage: flag(input, 'manage', base?.manage ?? type !== 'systemone'),
    autoStart: flag(input, 'autoStart', base?.autoStart ?? true),
    restartOnExit: flag(input, 'restartOnExit', base?.restartOnExit ?? true),
  };

  const serverDir = keptText(input, 'serverDir', base?.serverDir, 'serverDir', MAX_PATH);
  if (serverDir !== undefined) entry.serverDir = serverDir;
  const binary = keptText(input, 'binary', base?.binary, 'binary', MAX_PATH);
  if (binary !== undefined) entry.binary = binary;
  const args = keptText(input, 'args', base?.args, 'args', MAX_ARGS);
  if (args !== undefined) entry.args = args;
  const secretName = input.secretName === undefined && base
    ? base.secretName
    : envNameOf(input.secretName);
  if (secretName !== undefined) entry.secretName = secretName;
  const modelProfile = keptText(input, 'modelProfile', base?.modelProfile, 'modelProfile', MAX_TOKEN_NAME);
  if (modelProfile !== undefined) entry.modelProfile = modelProfile;
  const models = 'models' in input ? stringListOf(input.models, 'models') : base?.models;
  if (models !== undefined) entry.models = models;
  const tasks = 'tasks' in input ? stringListOf(input.tasks, 'tasks') : base?.tasks;
  if (tasks !== undefined) {
    const unique: string[] = [];
    for (const task of tasks) {
      if (!SERVICE_TASKS.has(task)) throw invalid(`unknown model task: ${task}`, 'tasks');
      if (!unique.includes(task)) unique.push(task);
    }
    entry.tasks = unique;
  }
  const options = 'options' in input ? jsonObjectOf(input.options, 'options', MAX_OPTIONS_BYTES) : base?.options;
  if (options !== undefined) entry.options = options;

  return entry;
}

/** 整组校验:id 唯一。 */
export function validateServices(services: readonly ServiceEntry[]): void {
  const ids = new Set<string>();
  for (const entry of services) {
    if (ids.has(entry.id)) throw invalid(`duplicate service id: ${entry.id}`, 'id');
    ids.add(entry.id);
  }
}

/** `saveGateway` 能写的标量;其余键一律拒绝,免得面板写进框架读不到的名字。 */
export type GatewayPatch = Partial<Pick<ServiceConfigSection,
  'enabled' | 'host' | 'port' | 'tokenSecret' | 'allowQueryToken' | 'requestTimeoutSec'
  | 'defaultSpeechModel'>>;

const GATEWAY_KEYS: ReadonlyArray<keyof GatewayPatch> = [
  'enabled', 'host', 'port', 'tokenSecret', 'allowQueryToken', 'requestTimeoutSec',
  'defaultSpeechModel',
];

function gatewayText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`, field);
  const text = value.trim();
  if ([...text].length > max) throw invalid(`${field} must be at most ${max} characters`, field);
  return noControl(text, field);
}

function gatewayFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean`, field);
  return value;
}

function gatewayInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid(`${field} must be an integer`, field);
  }
  if (value < min || value > max) {
    throw invalid(`${field} must be between ${min} and ${max}`, field);
  }
  return value;
}

/**
 * 把面板给的网关补丁归一成白名单标量。空补丁合法;未知键直接拒绝,
 * 不静默丢弃——面板拼错键名时应当报错而不是以为保存了。
 */
export function normalizeGatewayPatch(input: unknown): GatewayPatch {
  if (!isPlainObject(input)) throw invalid('gateway patch must be a JSON object', 'gateway');
  for (const key of Object.keys(input)) {
    if (!(GATEWAY_KEYS as readonly string[]).includes(key)) {
      throw invalid(`unknown gateway field: ${key}`, key);
    }
  }
  const patch: GatewayPatch = {};
  if ('enabled' in input) patch.enabled = gatewayFlag(input.enabled, 'enabled');
  if ('allowQueryToken' in input) {
    patch.allowQueryToken = gatewayFlag(input.allowQueryToken, 'allowQueryToken');
  }
  if ('host' in input) {
    const host = gatewayText(input.host, 'host', 255);
    if (!host) throw invalid('host is required', 'host');
    patch.host = host;
  }
  if ('port' in input) patch.port = gatewayInteger(input.port, 'port', 1, 65535);
  if ('requestTimeoutSec' in input) {
    patch.requestTimeoutSec = gatewayInteger(input.requestTimeoutSec, 'requestTimeoutSec', 5, 3600);
  }
  if ('tokenSecret' in input) {
    const name = gatewayText(input.tokenSecret, 'tokenSecret', MAX_TOKEN_NAME);
    if (name && !ENV_NAME_RE.test(name)) {
      throw invalid(`tokenSecret "${name}" is not an environment variable name`, 'tokenSecret');
    }
    patch.tokenSecret = name;
  }
  if ('defaultSpeechModel' in input) {
    patch.defaultSpeechModel = gatewayText(input.defaultSpeechModel, 'defaultSpeechModel', MAX_MODEL);
  }
  return patch;
}
