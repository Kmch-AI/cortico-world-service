/**
 * llama.cpp 的 JSON 接口:`POST /v1/embeddings` 与 `POST /v1/rerank`。
 * 请求体原样转发;rerank 的上游 404/405/501 表示该构建没有 rerank,映射成 501 unsupported。
 */
import { ServiceError } from '../errors.ts';
import type { JsonResult, TtsAudio } from '../types.ts';
import { jsonPost, readJsonResult, timedFetch } from './http.ts';
import type { JsonRequest, ProtocolAdapter } from './types.ts';

const RERANK_UNSUPPORTED = new Set([404, 405, 501]);

async function postEmbeddings(req: JsonRequest): Promise<JsonResult> {
  const { url, init } = jsonPost(req, '/embeddings');
  return timedFetch(req.fetch, url, init, req.timeoutMs, req.signal, readJsonResult);
}

async function postRerank(req: JsonRequest): Promise<JsonResult> {
  const { url, init } = jsonPost(req, '/rerank');
  return timedFetch(req.fetch, url, init, req.timeoutMs, req.signal, async (res) => {
    if (RERANK_UNSUPPORTED.has(res.status)) {
      // 先排空正文,否则连接可能停在半读状态。
      await res.text().catch(() => '');
      throw ServiceError.unsupported('upstream does not support rerank');
    }
    return readJsonResult(res);
  });
}

export const llamacppProtocol: ProtocolAdapter = {
  id: 'llamacpp',

  speech(): Promise<TtsAudio> {
    return Promise.reject(ServiceError.notfound('llamacpp service does not accept speech requests'));
  },

  embeddings: postEmbeddings,
  rerank: postRerank,
};
