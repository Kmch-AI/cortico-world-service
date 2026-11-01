/** OpenAI 兼容的 `POST /v1/audio/speech`。 */
import { endpointUrl } from '../entry.ts';
import type { TtsAudio } from '../types.ts';
import {
  apiUrl, authHeaders, readAudio, timedFetch,
} from './http.ts';
import type { ProtocolAdapter, ProtocolRequest } from './types.ts';

export async function postSpeech(req: ProtocolRequest): Promise<TtsAudio> {
  const secret = req.entry.secretName ? req.secret(req.entry.secretName) : '';
  return timedFetch(req.fetch, apiUrl(endpointUrl(req.entry), '/audio/speech'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(secret),
    },
    body: JSON.stringify(req.body),
  }, req.timeoutMs, req.signal, (res) => readAudio(res, req.format));
}

export const openaiProtocol: ProtocolAdapter = {
  id: 'openai',
  speech: postSpeech,
};
