/**
 * 从服务条目推导协议、端点、主机端口与健康路径。
 * 只读 `type` / `endpoint` / `serverDir`,不缓存,也不改变配置。
 */
import type { ServiceEntry, ServiceProtocol, ServiceType } from './types.ts';

export const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS: Partial<Record<ServiceType, number>> = {
  audiocpp: 8080,
  sing: 9882,
  svc: 9882,
};
const SCHEME_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

type EntryLike = Pick<ServiceEntry, 'type'>;
type EndpointLike = Pick<ServiceEntry, 'type' | 'endpoint'>;
type TypeArg = ServiceType | EntryLike;

function typeOf(value: TypeArg): ServiceType {
  return typeof value === 'string' ? value : value.type;
}

function defaultPort(type: ServiceType, protocol: string): number {
  return DEFAULT_PORTS[type] ?? SCHEME_PORTS[protocol] ?? 80;
}

/** 服务类型决定 HTTP 方言。 */
export function protocolOf(entryOrType: TypeArg): ServiceProtocol {
  switch (typeOf(entryOrType)) {
    case 'audiocpp': return 'audiocpp';
    case 'openai': return 'openai';
    case 'sing': return 'sing';
    case 'svc': return 'sing';
    case 'llamacpp': return 'none';
    case 'systemone': return 'openai';
    case 'custom': return 'custom';
  }
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/**
 * 归一化端点:无协议按 http;缺主机用 127.0.0.1;缺端口按类型补
 * (audiocpp 8080、sing/svc 9882、其余按协议)。保留路径,去掉末尾斜杠。
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
  if (!url.port) url.port = String(defaultPort(entry.type, url.protocol));
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** 从 endpointUrl 取主机与端口,给启动参数用。 */
export function hostPort(entry: EndpointLike): { host: string; port: number } {
  const url = new URL(endpointUrl(entry));
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = url.port ? Number(url.port) : defaultPort(entry.type, url.protocol);
  return { host: host || DEFAULT_HOST, port };
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
