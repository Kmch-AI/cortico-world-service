/**
 * 面板写入前的服务条目校验。所有值重新构造成白名单字段,未知键一律丢弃;
 * 命令与参数只作为 argv 交给 Supervisor,从不经过 shell。
 */
import { ServiceError } from './errors.ts';
import { ENV_NAME_RE } from './secrets.ts';
import { SERVICE_ID_RE, SERVICE_KINDS, SERVICE_PROTOCOLS } from './panel.ts';
import type { ModelProfile, ServiceEntry, ServiceKind, ServiceProtocol } from './types.ts';

const MAX_LABEL = 120;
const MAX_HOST = 255;
const MAX_URL = 2048;
const MAX_PATH = 2048;
const MAX_ARGS = 8192;
const MAX_TOKEN_NAME = 128;
const MAX_MODEL = 200;
const MAX_MODELS = 200;
const MAX_OPTIONS_BYTES = 64 * 1024;
const MAX_PROFILES_BYTES = 128 * 1024;
const DEFAULT_AUDIOCPP_PORT = 8000;

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

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  field: string,
  max: number,
): string | undefined {
  return key in raw ? textOf(raw[key], field, max) : undefined;
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

function portOf(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw invalid(`${field} must be an integer between 1 and 65535`, field);
  }
  return number;
}

function kindOf(value: unknown): ServiceKind {
  if (typeof value === 'string' && (SERVICE_KINDS as readonly string[]).includes(value)) {
    return value as ServiceKind;
  }
  throw invalid(`kind must be one of ${SERVICE_KINDS.join(', ')}`, 'kind');
}

function protocolOf(value: unknown): ServiceProtocol {
  if (typeof value === 'string' && (SERVICE_PROTOCOLS as readonly string[]).includes(value)) {
    return value as ServiceProtocol;
  }
  throw invalid(`protocol must be one of ${SERVICE_PROTOCOLS.join(', ')}`, 'protocol');
}

function defaultProtocol(kind: ServiceKind): ServiceProtocol {
  if (kind === 'audiocpp') return 'audiocpp';
  if (kind === 'llamacpp') return 'none';
  return 'openai';
}

function hostOf(value: unknown, field: string): string | undefined {
  const host = textOf(value, field, MAX_HOST);
  if (host !== undefined && /[\s/?#@]/.test(host)) {
    throw invalid(`${field} must be a host name or address without whitespace or URL parts`, field);
  }
  return host;
}

function httpUrl(value: unknown, field: string): string | undefined {
  const text = textOf(value, field, MAX_URL);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`${field} must be an http(s) URL`, field);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid(`${field} must be an http(s) URL`, field);
  }
  if (url.username || url.password) {
    throw invalid(`${field} must not embed credentials`, field);
  }
  return text.replace(/\/+$/, '');
}

function healthPathOf(value: unknown): string | undefined {
  const text = textOf(value, 'healthPath', MAX_URL);
  if (text === undefined) return undefined;
  if (/^https?:\/\//i.test(text)) return httpUrl(text, 'healthPath');
  if (/\s/.test(text)) throw invalid('healthPath must not contain whitespace', 'healthPath');
  return text.startsWith('/') ? text : `/${text}`;
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

function modelProfilesOf(
  value: unknown,
): Record<string, Partial<ModelProfile>> | undefined {
  const source = jsonObjectOf(value, 'modelProfiles', MAX_PROFILES_BYTES);
  if (source === undefined) return undefined;
  const out: Record<string, Partial<ModelProfile>> = {};
  for (const [id, profile] of Object.entries(source)) {
    if (!isPlainObject(profile)) {
      throw invalid(`modelProfiles.${id} must be a JSON object`, 'modelProfiles');
    }
    out[id] = profile as Partial<ModelProfile>;
  }
  return out;
}

/**
 * 把面板给的一条对象归一成 ServiceEntry。`base` 存在时是部分更新:
 * 缺省字段沿用旧值,`null` / 空串清掉可选字段;id 不允许改。
 */
export function normalizeEntry(input: unknown, base?: ServiceEntry): ServiceEntry {
  if (!isPlainObject(input)) throw invalid('service must be a JSON object', 'service');

  const rawId = base ? (input.id === undefined ? base.id : input.id) : input.id;
  const id = textOf(rawId, 'id', 64, true)!;
  if (!SERVICE_ID_RE.test(id)) {
    throw invalid('id must start with a letter or digit and use only letters, digits, dots, underscores and hyphens (max 64)', 'id');
  }
  if (base && id !== base.id) throw invalid('id cannot be changed; remove the entry and add a new one', 'id');

  const kind = input.kind === undefined && base ? base.kind : kindOf(input.kind ?? 'custom');
  const protocol = input.protocol === undefined && base
    ? base.protocol
    : protocolOf(input.protocol ?? defaultProtocol(kind));

  const entry: ServiceEntry = {
    id,
    kind,
    protocol,
    enabled: flag(input, 'enabled', base?.enabled ?? true),
    manage: flag(input, 'manage', base?.manage ?? true),
    autoStart: flag(input, 'autoStart', base?.autoStart ?? true),
    restartOnExit: flag(input, 'restartOnExit', base?.restartOnExit ?? true),
  };

  const label = keptText(input, 'label', base?.label, 'label', MAX_LABEL);
  if (label !== undefined) entry.label = label;
  const host = input.host === undefined && base ? base.host : hostOf(input.host, 'host');
  if (host !== undefined) entry.host = host;
  const port = 'port' in input ? portOf(input.port, 'port') : base?.port;
  if (port !== undefined) entry.port = port;
  const baseUrl = input.baseUrl === undefined && base ? base.baseUrl : httpUrl(input.baseUrl, 'baseUrl');
  if (baseUrl !== undefined) entry.baseUrl = baseUrl;
  const healthPath = input.healthPath === undefined && base ? base.healthPath : healthPathOf(input.healthPath);
  if (healthPath !== undefined) entry.healthPath = healthPath;
  const serverDir = keptText(input, 'serverDir', base?.serverDir, 'serverDir', MAX_PATH);
  if (serverDir !== undefined) entry.serverDir = serverDir;
  const binary = keptText(input, 'binary', base?.binary, 'binary', MAX_PATH);
  if (binary !== undefined) entry.binary = binary;
  const configPath = keptText(input, 'configPath', base?.configPath, 'configPath', MAX_PATH);
  if (configPath !== undefined) entry.configPath = configPath;
  const args = keptText(input, 'args', base?.args, 'args', MAX_ARGS);
  if (args !== undefined) entry.args = args;
  const secretName = input.secretName === undefined && base
    ? base.secretName
    : envNameOf(input.secretName);
  if (secretName !== undefined) entry.secretName = secretName;
  const modelProfile = keptText(input, 'modelProfile', base?.modelProfile, 'modelProfile', MAX_TOKEN_NAME);
  if (modelProfile !== undefined) entry.modelProfile = modelProfile;
  const modelProfiles = 'modelProfiles' in input ? modelProfilesOf(input.modelProfiles) : base?.modelProfiles;
  if (modelProfiles !== undefined) entry.modelProfiles = modelProfiles;
  const models = 'models' in input ? stringListOf(input.models, 'models') : base?.models;
  if (models !== undefined) entry.models = models;
  const options = 'options' in input ? jsonObjectOf(input.options, 'options', MAX_OPTIONS_BYTES) : base?.options;
  if (options !== undefined) entry.options = options;

  return entry;
}

function effectivePort(entry: ServiceEntry): number | null {
  if (typeof entry.port === 'number' && entry.port > 0) return entry.port;
  return entry.kind === 'audiocpp' ? DEFAULT_AUDIOCPP_PORT : null;
}

/** 整组校验:id 唯一;会拉起进程的条目不能共用同一 host:port。 */
export function validateServices(services: readonly ServiceEntry[]): void {
  const ids = new Set<string>();
  for (const entry of services) {
    if (ids.has(entry.id)) throw invalid(`duplicate service id: ${entry.id}`, 'id');
    ids.add(entry.id);
  }

  const listening = new Map<string, string>();
  for (const entry of services) {
    if (!entry.enabled || !entry.manage || entry.baseUrl?.trim()) continue;
    const port = effectivePort(entry);
    if (port === null) continue;
    const host = entry.host?.trim() || '127.0.0.1';
    const address = `${host}:${port}`;
    const other = listening.get(address);
    if (other) {
      throw invalid(`duplicate port ${address}: used by both ${other} and ${entry.id}`, 'port');
    }
    listening.set(address, entry.id);
  }
}
