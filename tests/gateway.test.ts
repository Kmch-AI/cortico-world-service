import { afterEach, describe, expect, it } from 'vitest';
import { ServiceError } from '../src/errors.ts';
import {
  gatewayAuthError, isLoopbackHost, startGateway, type GatewayHandlers, type GatewayHandle,
  type GatewayOptions,
} from '../src/gateway/server.ts';
import type {
  EmbeddingsRequest, RerankRequest, SingRequest, SpeechRequest, SystemOneRequest,
} from '../src/types.ts';
import { quietLogger } from './helpers/quiet.ts';
import { wavBytes } from './helpers/wav.ts';

const handles: GatewayHandle[] = [];
const audio = wavBytes(1);

function handlers(patch: Partial<GatewayHandlers> = {}): GatewayHandlers {
  return {
    health: () => ({
      status: 'ok', ready: true, version: '0.1.0', uptimeSec: 12, services: [], models: 2,
    }),
    models: () => [{
      id: 'tts-1', object: 'model', owned_by: 'cortico-world-service', service: 'svc',
    }],
    voices: () => ({
      model: 'tts-1',
      voices: ['alloy'],
      data: [{ id: 'svc:tts-1:alloy', value: 'alloy', label: 'alloy', model: 'tts-1', service: 'svc' }],
    }),
    speech: async () => ({ bytes: audio, mime: 'audio/wav', seconds: 1 }),
    sing: async () => ({ bytes: audio, mime: 'audio/wav', seconds: 1 }),
    ...patch,
  };
}

async function gateway(
  patch: Partial<GatewayHandlers> = {},
  opts: Partial<GatewayOptions> = {},
): Promise<{ handle: GatewayHandle; base: string }> {
  const handle = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: '',
    tokenRequired: false,
    allowQueryToken: false,
    handlers: handlers(patch),
    log: quietLogger,
    ...opts,
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
});

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json() as { error?: Record<string, unknown> };
  return body.error ?? {};
}

describe('gateway auth', () => {
  it('回环地址可以无令牌;非回环与空令牌变量都拒绝', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.999')).toBe(false);
    expect(gatewayAuthError({ host: '127.0.0.1', tokenSecret: '' }, '')).toBeNull();
    expect(gatewayAuthError({ host: '0.0.0.0', tokenSecret: '' }, '')).toContain('tokenSecret');
    expect(gatewayAuthError({ host: '127.0.0.1', tokenSecret: 'SVC_TOKEN' }, '')).toContain('SVC_TOKEN');
    expect(gatewayAuthError({ host: '0.0.0.0', tokenSecret: 'SVC_TOKEN' }, 'abc')).toBeNull();
  });

  it('Bearer 令牌;查询参数令牌只在 allowQueryToken 时接受', async () => {
    const { base } = await gateway({}, { token: 'sekret', tokenRequired: true });
    const none = await fetch(`${base}/health`);
    expect(none.status).toBe(401);
    expect(await errorOf(none)).toMatchObject({ type: 'authentication_error', code: 'invalid_token' });

    const wrong = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);

    const good = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer sekret' } });
    expect(good.status).toBe(200);

    const query = await fetch(`${base}/health?token=sekret`);
    expect(query.status).toBe(401);

    const { base: open } = await gateway({}, {
      token: 'sekret', tokenRequired: true, allowQueryToken: true,
    });
    const allowed = await fetch(`${open}/health?token=sekret`);
    expect(allowed.status).toBe(200);
    const headerStill = await fetch(`${open}/health`, { headers: { Authorization: 'Bearer sekret' } });
    expect(headerStill.status).toBe(200);
  });
});

describe('gateway routes', () => {
  it('GET /health 原样返回聚合状态', async () => {
    const { base } = await gateway();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok', ready: true, version: '0.1.0', uptimeSec: 12, services: [], models: 2,
    });
  });

  it('GET /v1/models 是 OpenAI 形状', async () => {
    const { base } = await gateway();
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: 'list',
      data: [{ id: 'tts-1', object: 'model', owned_by: 'cortico-world-service', service: 'svc' }],
    });
  });

  it('GET /v1/audio/voices 带 model 与 data', async () => {
    let seen: { model?: string; service?: string } | undefined;
    const { base } = await gateway({
      voices: (query) => {
        seen = query;
        return {
          model: 'tts-1',
          voices: ['alloy'],
          data: [{ id: 'svc:tts-1:alloy', value: 'alloy', label: 'alloy', model: 'tts-1', service: 'svc' }],
        };
      },
    });
    const res = await fetch(`${base}/v1/audio/voices?model=tts-1&service=svc`);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ model: 'tts-1', service: 'svc' });
    expect(await res.json()).toEqual({
      object: 'list',
      model: 'tts-1',
      voices: ['alloy'],
      data: [{ id: 'svc:tts-1:alloy', value: 'alloy', label: 'alloy', model: 'tts-1', service: 'svc' }],
    });
  });

  it('POST /v1/audio/speech 解析字段并返回音频', async () => {
    let seen: SpeechRequest | undefined;
    const { base } = await gateway({
      speech: async (request) => {
        seen = request;
        return { bytes: audio, mime: 'audio/wav', seconds: 1 };
      },
    });
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        input: '  hello  ',
        voice: 'alloy',
        response_format: 'wav',
        speed: 1.25,
        instructions: '  softly ',
        emotion: 'calm',
        language: 'zh',
        options: { template_name: 'freeform' },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('x-voice-seconds')).toBe('1.00');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(audio));
    expect(seen).toEqual({
      model: 'tts-1',
      input: 'hello',
      voice: 'alloy',
      format: 'wav',
      speed: 1.25,
      instructions: 'softly',
      emotion: 'calm',
      language: 'zh',
      options: { template_name: 'freeform' },
    });
  });

  it('POST /v1/audio/sing 解析歌词', async () => {
    let seen: SingRequest | undefined;
    const { base } = await gateway({
      sing: async (request) => {
        seen = request;
        return { bytes: audio, mime: 'audio/wav' };
      },
    });
    const res = await fetch(`${base}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'singer-1', lyrics: '  la la  ' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual({ model: 'singer-1', lyrics: 'la la' });
  });

  it('未知路由与错误方法都是 404,LLM 路由不代理', async () => {
    const { base } = await gateway();
    const missing = await fetch(`${base}/v1/nope`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ type: 'not_found_error', code: 'not_found' });
    const wrongMethod = await fetch(`${base}/health`, { method: 'POST' });
    expect(wrongMethod.status).toBe(404);

    for (const path of ['/v1/chat/completions', '/v1/responses']) {
      const llm = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(llm.status).toBe(404);
    }
  });
});

describe('gateway JSON routes', () => {
  it('POST /v1/systemone 原样交给 handler 并保留状态与正文', async () => {
    let seen: SystemOneRequest | undefined;
    const body = {
      model: 'sys-1',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
    };
    const { base } = await gateway({
      systemone: async (request) => {
        seen = request;
        return { status: 201, body: { ok: true } };
      },
    });
    const res = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual({ model: 'sys-1', body });
  });

  it('POST /v1/embeddings 解析字段并保留原始 body', async () => {
    let seen: EmbeddingsRequest | undefined;
    const body = { model: 'embed-1', input: ['alpha', 'beta'], dimensions: 8, extra: 'kept' };
    const { base } = await gateway({
      embeddings: async (request) => {
        seen = request;
        return { status: 200, body: { object: 'list', data: [] } };
      },
    });
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: 'list', data: [] });
    expect(seen).toEqual({
      model: 'embed-1',
      input: ['alpha', 'beta'],
      dimensions: 8,
      body,
    });
  });

  it('POST /v1/rerank 解析字段并保留原始 body', async () => {
    let seen: RerankRequest | undefined;
    const body = {
      model: 'rerank-1',
      query: '  what is cortico  ',
      documents: ['a bot harness', 'a weather service'],
      top_n: 1,
    };
    const { base } = await gateway({
      rerank: async (request) => {
        seen = request;
        return { status: 200, body: { results: [{ index: 1, relevance_score: 0.9 }] } };
      },
    });
    const res = await fetch(`${base}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual({
      model: 'rerank-1',
      query: 'what is cortico',
      documents: ['a bot harness', 'a weather service'],
      top_n: 1,
      body,
    });
  });

  it('缺少 handler 时三个路由都回 501 unsupported', async () => {
    const { base } = await gateway();
    for (const [path, body] of [
      ['/v1/systemone', {}],
      ['/v1/embeddings', { input: 'hi' }],
      ['/v1/rerank', { query: 'q', documents: ['a'] }],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(501);
      expect(await errorOf(res)).toMatchObject({
        type: 'invalid_request_error',
        code: 'unsupported',
      });
    }
  });

  it('新的 JSON 路由仍要求令牌', async () => {
    const ok = async (): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { ok: true } });
    const { base } = await gateway({
      systemone: ok,
      embeddings: ok,
      rerank: ok,
    }, { token: 'sekret', tokenRequired: true });
    for (const [path, body] of [
      ['/v1/systemone', {}],
      ['/v1/embeddings', { input: 'hi' }],
      ['/v1/rerank', { query: 'q', documents: ['a'] }],
    ] as const) {
      const denied = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer sekret',
        },
        body: JSON.stringify(body),
      });
      expect(allowed.status).toBe(200);
    }
  });

  it('JSON 路由校验对象与必填字段', async () => {
    const { base } = await gateway({
      systemone: async () => ({ status: 200, body: {} }),
      embeddings: async () => ({ status: 200, body: {} }),
      rerank: async () => ({ status: 200, body: {} }),
    });
    const notObject = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(notObject.status).toBe(400);

    const noInput = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embed-1' }),
    });
    expect(noInput.status).toBe(400);
    expect(await errorOf(noInput)).toMatchObject({ param: 'input' });

    const noDocuments = await fetch(`${base}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
    });
    expect(noDocuments.status).toBe(400);
    expect(await errorOf(noDocuments)).toMatchObject({ param: 'documents' });
  });
});

describe('gateway limits', () => {
  it('缺 input、超长 input/instructions 都是 400', async () => {
    const { base } = await gateway();
    const missing = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '' }),
    });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toMatchObject({ param: 'input', type: 'invalid_request_error' });

    const longInput = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'a'.repeat(8001) }),
    });
    expect(longInput.status).toBe(400);
    expect(await errorOf(longInput)).toMatchObject({ param: 'input' });

    const longInstructions = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', instructions: 'x'.repeat(2001) }),
    });
    expect(longInstructions.status).toBe(400);
    expect(await errorOf(longInstructions)).toMatchObject({ param: 'instructions' });
  });

  it('options 超 16 KiB 是 413;play 被拒绝', async () => {
    const { base } = await gateway();
    const bigOptions = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', options: { blob: 'x'.repeat(17 * 1024) } }),
    });
    expect(bigOptions.status).toBe(413);
    expect(await errorOf(bigOptions)).toMatchObject({ code: 'request_too_large', param: 'options' });

    const play = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', play: true }),
    });
    expect(play.status).toBe(400);
    expect(await errorOf(play)).toMatchObject({ param: 'play' });

    const singPlay = await fetch(`${base}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: 'la', play: true }),
    });
    expect(singPlay.status).toBe(400);
    expect(await errorOf(singPlay)).toMatchObject({ param: 'play' });
  });

  it('请求体超 1 MiB 是 413', async () => {
    const { base } = await gateway();
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'request_too_large' });
  });

  it('非法 JSON 与非法 response_format 是 400', async () => {
    const { base } = await gateway();
    const badJson = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(badJson.status).toBe(400);
    const badFormat = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', response_format: 'flac' }),
    });
    expect(badFormat.status).toBe(400);
    expect(await errorOf(badFormat)).toMatchObject({ param: 'response_format' });
  });
});

describe('gateway error mapping', () => {
  it.each([
    [new ServiceError('notfound', 'gone'), 404, 'not_found_error'],
    [new ServiceError('rate', 'full'), 429, 'rate_limit_error'],
    [new ServiceError('upstream', 'bad upstream'), 502, 'upstream_error'],
    [new ServiceError('timeout', 'slow'), 504, 'timeout_error'],
  ] as const)('ServiceError %s → %i', async (error, status, type) => {
    const { base } = await gateway({ speech: async () => { throw error; } });
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ type });
  });

  it('503 带 Retry-After: 2;未知错误回落 502', async () => {
    const { base } = await gateway({
      speech: async () => { throw ServiceError.unavailable('not ready'); },
      sing: async () => { throw new Error('boom'); },
    });
    const unavailable = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('2');
    expect(await errorOf(unavailable)).toMatchObject({ code: 'not_ready' });

    const unknown = await fetch(`${base}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: 'la' }),
    });
    expect(unknown.status).toBe(502);
    expect(await errorOf(unknown)).toMatchObject({ code: 'upstream_failed' });
  });
});
