/** 协议适配器共用的 HTTP 小工具:地址拼接、鉴权头、超时、错误正文、音频与 JSON 回应。 */
import { endpointUrl } from '../entry.ts';
import { ServiceError, errorMessage } from '../errors.ts';
import type { AudioFormat, JsonResult, TtsAudio, VoiceOption } from '../types.ts';
import type { JsonRequest } from './types.ts';

/** 基础地址可以带 `/v1`,也可以不带;两种都拼出同一个接口。 */
export function apiUrl(base: string, path: string): string {
  const trimmed = (base || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw ServiceError.invalid('service endpoint is empty');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return /\/v1$/.test(trimmed) ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`;
}

export function mimeOf(format: AudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

export function mimeFormat(type: string): AudioFormat | undefined {
  const value = type.toLowerCase();
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('wav')) return 'wav';
  return undefined;
}

export function authHeaders(secret: string | undefined): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/**
 * 非音频协议共用的 JSON POST:地址按 apiUrl 拼接(基础地址可带 `/v1`),
 * 正文原样序列化,`entry.secretName` 读到的值作为 Bearer。
 */
export function jsonPost(req: JsonRequest, path: string): { url: string; init: RequestInit } {
  const secret = req.entry.secretName ? req.secret(req.entry.secretName) : '';
  return {
    url: apiUrl(endpointUrl(req.entry), path),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(secret),
      },
      body: JSON.stringify(req.body),
    },
  };
}

/** 上游 JSON 回应:成功时原样解析,空正文给 null;非 2xx 与坏正文都是 upstream。 */
export async function readJsonResult(res: Response): Promise<JsonResult> {
  if (!res.ok) throw ServiceError.upstream(await errorSnippet(res));
  const text = await res.text();
  if (!text.trim()) return { status: res.status, body: null };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw ServiceError.upstream('upstream returned invalid JSON');
  }
}

/** 读一小段错误正文,压成一行。 */
export async function errorSnippet(res: Response, limit = 600): Promise<string> {
  let body = '';
  try { body = await res.text(); } catch { /* 读不到就用状态行 */ }
  const flat = body.replace(/\s+/g, ' ').trim();
  return `upstream ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${flat ? `: ${flat.slice(0, limit)}` : ''}`;
}

export function wavSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420 && body + 16 <= bytes.length) byteRate = view.getUint32(body + 8, true);
    if (id === 0x64617461) {
      if (byteRate > 0 && size > 0) return size / byteRate;
      return undefined;
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

/**
 * 网关只回 `audio/wav` 或 `audio/mpeg`。上游给的类型能认出格式时用它,
 * 认不出(如 `application/octet-stream`)就按请求的 response_format 定。
 */
export function audioOf(bytes: Uint8Array, format: AudioFormat, mime?: string): TtsAudio {
  const detected = mimeFormat(mime ?? '');
  const type = mimeOf(detected ?? format);
  const seconds = wavSeconds(bytes);
  return seconds === undefined ? { bytes, mime: type } : { bytes, mime: type, seconds };
}

/**
 * 带超时与外部取消的 fetch。超时覆盖到回应体读完:传入 `read` 时,整个读体过程
 * 也受同一个期限约束。超时抛 `timeout`,网络错误抛 `upstream`;外部 signal 取消时
 * 保留原错误,交给调用方按断连处理。
 */
export async function timedFetch<T = Response>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  read?: (res: Response) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error(`timed out after ${timeoutMs} ms`));
  }, Math.max(1, timeoutMs));
  const forward = (): void => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  const timedOutError = (): ServiceError => ServiceError.timeout(
    `upstream did not answer within ${timeoutMs} ms`,
  );
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (error) {
      if (timedOut) throw timedOutError();
      if (signal?.aborted) throw error;
      throw ServiceError.upstream(`upstream request failed: ${errorMessage(error)}`, error);
    }
    if (!read) return res as T;
    try {
      return await read(res);
    } catch (error) {
      if (timedOut) throw timedOutError();
      throw error;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** 回应必须是音频;不是时报错并带正文。 */
export async function readAudio(res: Response, format: AudioFormat): Promise<TtsAudio> {
  if (!res.ok) throw ServiceError.upstream(await errorSnippet(res));
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('audio/') && !type.includes('octet-stream')) {
    throw ServiceError.upstream(await errorSnippet(res));
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw ServiceError.upstream('upstream returned an empty audio body');
  return audioOf(bytes, mimeFormat(type) ?? format, type);
}

/** `{voices:[...]}` / `{data:[...]}` / 裸数组都接受;字符串与对象项都归一。 */
export function parseVoices(raw: unknown): VoiceOption[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (() => {
        const o = raw as Record<string, unknown>;
        if (Array.isArray(o.voices)) return o.voices;
        if (Array.isArray(o.data)) return o.data;
        if (Array.isArray(o.items)) return o.items;
        return [];
      })()
      : [];
  const out: VoiceOption[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let value = '';
    let label = '';
    if (typeof item === 'string') {
      value = item.trim();
      label = value;
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      value = typeof o.id === 'string' ? o.id.trim()
        : typeof o.value === 'string' ? o.value.trim()
          : typeof o.name === 'string' ? o.name.trim() : '';
      label = typeof o.label === 'string' ? o.label
        : typeof o.display_name === 'string' ? o.display_name
          : typeof o.displayName === 'string' ? o.displayName
            : typeof o.name === 'string' ? o.name : value;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: label.trim() || value });
  }
  return out;
}

export function parseJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
}
