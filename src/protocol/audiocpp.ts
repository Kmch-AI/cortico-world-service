/**
 * audiocpp 的 `/v1/audio/speech`。外形与 OpenAI 相同,差别在模型 profile 生成的
 * `options` 对象(例如 Ming 3.0 的 template_name),这里原样转交。
 */
import { serviceBaseUrl } from '../supervisor.ts';
import type { VoiceOption } from '../types.ts';
import {
  apiUrl, authHeaders, parseJson, parseVoices, timedFetch,
} from './http.ts';
import { postSpeech } from './openai.ts';
import type { ProtocolAdapter, VoiceListRequest } from './types.ts';

export async function fetchAudiocppVoices(req: VoiceListRequest): Promise<VoiceOption[]> {
  const secret = req.entry.secretName ? req.secret(req.entry.secretName) : '';
  const url = new URL(apiUrl(serviceBaseUrl(req.entry), '/audio/voices'));
  if (req.model?.trim()) url.searchParams.set('model', req.model.trim());
  try {
    return await timedFetch(req.fetch, url.toString(), {
      method: 'GET',
      headers: authHeaders(secret),
    }, Math.min(req.timeoutMs, 8000), undefined, async (res) => {
      if (!res.ok) return [];
      return parseVoices(parseJson(await res.text()));
    });
  } catch {
    return [];
  }
}

export const audiocppProtocol: ProtocolAdapter = {
  id: 'audiocpp',
  speech: postSpeech,
  listVoices: fetchAudiocppVoices,
};
