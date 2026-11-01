/**
 * 唱歌插件的 HTTP 连接:`POST <base>/sing {lyrics, model?}` → `audio/wav`
 * 或 `{audioBase64, mime}`。路径可用条目的 `options.path` 覆盖。
 */
import { ServiceError } from '../errors.ts';
import { endpointUrl } from '../entry.ts';
import type { TtsAudio } from '../types.ts';
import {
  audioOf, authHeaders, errorSnippet, mimeOf, timedFetch,
} from './http.ts';
import type { ProtocolAdapter, ProtocolRequest } from './types.ts';

function singUrl(req: ProtocolRequest): string {
  const explicit = req.entry.options?.path;
  const base = endpointUrl(req.entry);
  if (typeof explicit === 'string' && explicit.trim()) {
    const path = explicit.trim();
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
  const url = new URL(base);
  if (!/\/sing$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/sing`;
  return url.toString();
}

export const singProtocol: ProtocolAdapter = {
  id: 'sing',

  speech(): Promise<TtsAudio> {
    return Promise.reject(ServiceError.notfound('singing service does not accept speech requests'));
  },

  async sing(req: ProtocolRequest): Promise<TtsAudio> {
    const secret = req.entry.secretName ? req.secret(req.entry.secretName) : '';
    return timedFetch(req.fetch, singUrl(req), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(secret),
      },
      body: JSON.stringify(req.body),
    }, req.timeoutMs, req.signal, async (res) => {
      if (!res.ok) throw ServiceError.upstream(await errorSnippet(res));
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.startsWith('audio/') || type.includes('octet-stream')) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length) throw ServiceError.upstream('singing service returned an empty body');
        return audioOf(bytes, req.format, type);
      }
      const data = await res.json().catch(() => null) as { audioBase64?: unknown; mime?: unknown } | null;
      if (typeof data?.audioBase64 === 'string' && data.audioBase64) {
        const bytes = new Uint8Array(Buffer.from(data.audioBase64, 'base64'));
        if (!bytes.length) throw ServiceError.upstream('singing service returned empty audio');
        const mime = typeof data.mime === 'string' ? data.mime : mimeOf('wav');
        return audioOf(bytes, 'wav', mime);
      }
      throw ServiceError.upstream('singing service returned no audio');
    });
  },
};
