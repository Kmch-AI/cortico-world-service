/**
 * SystemOne 的 `POST /v1/systemone`:请求体与上游 JSON 回应都原样转发。
 * 服务层不做 token 截断;大小只受网关的 BODY_MAX 限制。
 */
import { ServiceError } from '../errors.ts';
import type { JsonResult, TtsAudio } from '../types.ts';
import { jsonPost, readJsonResult, timedFetch } from './http.ts';
import type { JsonRequest, ProtocolAdapter } from './types.ts';

async function postSystemOne(req: JsonRequest): Promise<JsonResult> {
  const { url, init } = jsonPost(req, '/systemone');
  return timedFetch(req.fetch, url, init, req.timeoutMs, req.signal, readJsonResult);
}

export const systemoneProtocol: ProtocolAdapter = {
  id: 'systemone',

  speech(): Promise<TtsAudio> {
    return Promise.reject(ServiceError.notfound('systemone service does not accept speech requests'));
  },

  systemone: postSystemOne,
};
