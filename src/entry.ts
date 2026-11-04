/**
 * 从服务条目推导协议、端点、主机端口与健康路径。
 * 只读 `type` / `endpoint` / `serverDir`,不缓存,也不改变配置。
 */
import type { ServiceEntry, ServiceProtocol, ServiceType } from './types.ts';

export const DEFAULT_HOST = '127.0.0.1';
/** 含 0.8 及更早的旧类型,旧配置仍能取到原来的默认端口。 */
const DEFAULT_PORTS: Record<string, number> = {
  audiocpp: 8080,
  sing: 9882,
  svc: 9882,
};
/** 本地预设端口;只在回环地址补齐,外部域名仍按 http/https 取 80/443。 */
const LOOPBACK_PORTS: Record<string, number> = {
  llamacpp: 8081,
  // StartLux Decision 与外部 SystemOne 的本地默认端口。
  startlux: 8091,
  systemone: 8091,
};
const SCHEME_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

type EntryLike = Pick<ServiceEntry, 'type'>;
type EndpointLike = Pick<ServiceEntry, 'type' | 'endpoint'>;
type TypeArg = ServiceType | EntryLike;

function typeOf(value: TypeArg): ServiceType {
  return typeof value === 'string' ? value : value.type;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

function defaultPort(type: ServiceType, protocol: string, hostname: string): number {
  const local = LOOPBACK_PORTS[type];
  if (local !== undefined && isLoopbackHost(hostname)) return local;
  return DEFAULT_PORTS[type] ?? SCHEME_PORTS[protocol] ?? 80;
}

/** 服务类型决定 HTTP 方言。旧配置里的 `svc` / `custom` 仍按原方言处理。 */
export function protocolOf(entryOrType: TypeArg): ServiceProtocol {
  switch (typeOf(entryOrType) as string) {
    case 'audiocpp': return 'audiocpp';
    case 'openai': return 'openai';
    case 'sing': return 'sing';
    case 'llamacpp': return 'llamacpp';
    case 'startlux': return 'systemone';
    case 'systemone': return 'systemone';
    case 'svc': return 'sing';
    case 'custom': return 'custom';
    default: return 'openai';
  }
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/**
 * 归一化端点:无协议按 http;缺主机用 127.0.0.1;缺端口按类型补
 * (audiocpp 8080、sing 9882;llamacpp/startlux/systemone 只在回环地址补 8081/8091,
 * 外部域名按协议 80/443)。保留路径,去掉末尾斜杠。
 */
export function endpointUrl(entry: EndpointLike): string {
  const raw = (entry.endpoint ?? '').trim();
  const candidate = hasScheme(raw) ? raw : `http://${raw || DEFAULT_HOST}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    url = new URL(`http://${DEFAULT_HOST}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    url = new URL(`http://${DEFAULT_HOST}`);
  }
  if (!url.port) url.port = String(defaultPort(entry.type, url.protocol, url.hostname));
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** 从 endpointUrl 取主机与端口,给启动参数用。 */
export function hostPort(entry: EndpointLike): { host: string; port: number } {
  const url = new URL(endpointUrl(entry));
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = url.port ? Number(url.port) : defaultPort(entry.type, url.protocol, url.hostname);
  return { host: host || DEFAULT_HOST, port };
}

/**
 * 条目承载的模型任务；显式 `tasks` 优先，否则按服务类型给默认值。
 * `systemone` 与 `embeddings` / `rerank` 是同一级任务。
 */
export function tasksOfEntry(entry: Pick<ServiceEntry, 'type' | 'tasks'>): string[] {
  if (entry.tasks?.length) return entry.tasks;
  switch (entry.type as string) {
    case 'sing':
    case 'svc':
      return ['sing'];
    case 'llamacpp': return ['embeddings', 'rerank'];
    case 'startlux':
    case 'systemone':
      return ['systemone'];
    case 'audiocpp':
    case 'openai':
    case 'custom':
      return ['tts'];
    default:
      return [];
  }
}

/** llama.cpp 的启动方式：多模型用 `--models-dir`，单模型用 `-m`。 */
export type LlamacppLaunchMode = 'router' | 'single';

/**
 * 解析 llama.cpp 条目的启动方式。显式 `options.launchMode` 优先；旧配置按 args 推断：
 * 带 `--models-dir` 的是多模型，带 `-m` / `--model` 的是单模型。
 * 0.8 及更早的 `serve` 与空配置都按多模型处理。
 */
export function llamacppLaunchMode(
  entry: Pick<ServiceEntry, 'type' | 'args' | 'options'>,
): LlamacppLaunchMode {
  if (entry.type !== 'llamacpp') return 'single';
  const explicit = entry.options?.launchMode;
  if (explicit === 'router' || explicit === 'single') return explicit;
  const args = entry.args ?? '';
  if (/(^|\s)--models-dir(\s|=)/.test(args)) return 'router';
  if (/(^|\s)(-m|--model)(\s|=)/.test(args)) return 'single';
  return 'router';
}

/** 只有托管进程、没有 HTTP 协议的条目返回 null。 */
export function healthPathOf(entryOrType: TypeArg): string | null {
  return protocolOf(entryOrType) === 'none' ? null : '/health';
}

/** 探活地址;协议为 none 时没有探活。 */
export function healthUrl(entry: EndpointLike): string | null {
  if (!healthPathOf(entry.type)) return null;
  const url = new URL(endpointUrl(entry));
  return `${url.protocol}//${url.host}/health`;
}

/** audiocpp 的配置文件固定为 `<serverDir>/server.json`。 */
export function serverJsonPath(entry: Pick<ServiceEntry, 'serverDir'>): string | null {
  const dir = entry.serverDir?.trim();
  if (!dir) return null;
  const trimmed = dir.replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}server.json`;
}

/** 把名字压成 id 可用的 ASCII slug;没有可用字符时返回空串。 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * 生成服务 id:ASCII 名字取 slug;中文或空名字取 `<type>-<序号>`。
 * 与已有 id 冲突时追加序号。
 */
export function serviceIdFor(name: string, type: ServiceType, existing: readonly string[] = []): string {
  const taken = new Set(existing);
  const slug = slugify(name);
  if (slug) {
    if (!taken.has(slug)) return slug;
    for (let index = 2; ; index += 1) {
      const candidate = `${slug}-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  for (let index = 1; ; index += 1) {
    const candidate = `${type}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
