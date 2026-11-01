/**
 * 自定义 JSON 协议:请求方法、头与请求体都能在条目的 `options` 里配,
 * 回应可以是音频字节、base64 字段或一个音频地址。给没有专门适配器的服务留的出口。
 *
 * 读取的 options:`url`(优先于 endpoint)、`path`(追加到 endpoint 后)、`method`、
 * `headers`、`body`、`response`('audio'|'base64'|'url')、`audioPath`。endpoint 本身就是
 * 请求地址;给 `path` 时才在它后面追加。`body` 里的 `{{text}}` 等占位符用语义字段替换;
 * 头里的 `${KEY}` 换成 `secretName` 读到的密钥。
 */
import { endpointUrl } from '../entry.ts';
import { ServiceError } from '../errors.ts';
import type { TtsAudio } from '../types.ts';
import {
  audioOf, errorSnippet, mimeOf, parseJson, timedFetch,
} from './http.ts';
import type { ProtocolAdapter, ProtocolRequest } from './types.ts';

const DEFAULT_BODY = '{"text":"{{text}}","voice":"{{voice}}"}';

function optionString(req: ProtocolRequest, key: string, fallback = ''): string {
  const value = req.entry.options?.[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

function quote(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function bodyOf(template: string, values: Record<string, string>): string {
  return (template.trim() || DEFAULT_BODY).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key: string) => {
    const value = values[key.toLowerCase()];
    if (value === undefined) return whole;
    // speed 是数字,原样放;其余按 JSON 字符串内容转义。
    return key.toLowerCase() === 'speed' ? value : quote(value);
  });
}

function headersOf(req: ProtocolRequest): Record<string, string> {
  const raw = req.entry.options?.headers;
  let parsed: unknown = {};
  if (typeof raw === 'string' && raw.trim()) {
    parsed = parseJson(raw);
    if (parsed === null) throw ServiceError.invalid('options.headers is not valid JSON', 'options.headers');
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ServiceError.invalid('options.headers must be a JSON object', 'options.headers');
  }
  const secret = req.entry.secretName ? req.secret(req.entry.secretName) : '';
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw ServiceError.invalid(`options.headers.${key} must be a string`, `options.headers.${key}`);
    }
    out[key] = value.split('${KEY}').join(secret);
  }
  if (secret && !Object.keys(out).some((key) => key.toLowerCase() === 'authorization')) {
    out.Authorization = `Bearer ${secret}`;
  }
  return out;
}

function pickPath(data: unknown, path: string): unknown {
  let cur = data;
  for (const seg of (path || 'audio').split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function decodeBase64(raw: string): Uint8Array {
  const comma = raw.indexOf(',');
  const body = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length) throw ServiceError.upstream('custom response base64 field is empty');
  return new Uint8Array(bytes);
}

function targetUrl(req: ProtocolRequest): string {
  const explicit = optionString(req, 'url');
  if (explicit) return explicit;
  const base = endpointUrl(req.entry);
  const path = optionString(req, 'path');
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export const customProtocol: ProtocolAdapter = {
  id: 'custom',

  async speech(req: ProtocolRequest): Promise<TtsAudio> {
    const method = optionString(req, 'method', 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const headers = headersOf(req);
    const target = targetUrl(req);
    let url = target;
    const init: RequestInit = { method, headers };

    if (method === 'GET') {
      const parsed = new URL(target);
      for (const [key, value] of Object.entries(req.values)) {
        if (value) parsed.searchParams.set(key, value);
      }
      url = parsed.toString();
    } else {
      const template = optionString(req, 'body');
      const body = template ? bodyOf(template, req.values) : JSON.stringify(req.body);
      if (template) {
        try { JSON.parse(body); } catch {
          throw ServiceError.invalid('options.body is not valid JSON after placeholders were filled', 'options.body');
        }
      }
      headers['Content-Type'] ??= 'application/json';
      init.body = body;
    }

    return timedFetch(req.fetch, url, init, req.timeoutMs, req.signal, async (res) => {
      if (!res.ok) throw ServiceError.upstream(await errorSnippet(res));
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.startsWith('audio/') || type.includes('octet-stream')) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length) throw ServiceError.upstream('custom API returned an empty audio body');
        return audioOf(bytes, req.format, type);
      }

      const mode = optionString(req, 'response', 'auto');
      if (mode === 'audio') throw ServiceError.upstream(await errorSnippet(res));
      const data = await res.json();
      const path = optionString(req, 'audioPath', 'audio');
      let value = pickPath(data, path);
      if (typeof value !== 'string' && path === 'audio') {
        const fallback = pickPath(data, 'audioBase64');
        if (typeof fallback === 'string') value = fallback;
      }
      if (typeof value !== 'string' || !value.trim()) {
        throw ServiceError.upstream(`custom response has no string at ${path}`);
      }
      if (mode === 'base64') {
        const mime = typeof (data as { mime?: unknown })?.mime === 'string'
          ? (data as { mime: string }).mime
          : mimeOf(req.format);
        return audioOf(decodeBase64(value), req.format, mime);
      }
      if (mode === 'url' || /^https?:\/\//i.test(value) || value.startsWith('/')) {
        const audioUrl = new URL(value, url).toString();
        return timedFetch(req.fetch, audioUrl, { method: 'GET', headers }, req.timeoutMs, req.signal,
          async (audioRes) => {
            if (!audioRes.ok) throw ServiceError.upstream(await errorSnippet(audioRes));
            const bytes = new Uint8Array(await audioRes.arrayBuffer());
            if (!bytes.length) throw ServiceError.upstream('custom audio URL returned an empty body');
            return audioOf(bytes, req.format, audioRes.headers.get('content-type') ?? undefined);
          });
      }
      return audioOf(decodeBase64(value), req.format);
    });
  },
};
