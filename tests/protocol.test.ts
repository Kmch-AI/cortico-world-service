import { afterEach, describe, expect, it } from 'vitest';
import { ServiceError } from '../src/errors.ts';
import { audiocppProtocol } from '../src/protocol/audiocpp.ts';
import { customProtocol } from '../src/protocol/custom.ts';
import { openaiProtocol } from '../src/protocol/openai.ts';
import { wavSeconds } from '../src/protocol/http.ts';
import { singProtocol } from '../src/protocol/sing.ts';
import type { ProtocolRequest, VoiceListRequest } from '../src/protocol/types.ts';
import type { ServiceEntry } from '../src/types.ts';
import { audio, json, startUpstream, type Upstream } from './helpers/upstream.ts';
import { wavBytes } from './helpers/wav.ts';

const upstreams: Upstream[] = [];

async function upstream(
  handler: Parameters<typeof startUpstream>[0],
): Promise<Upstream> {
  const server = await startUpstream(handler);
  upstreams.push(server);
  return server;
}

afterEach(async () => {
  for (const server of upstreams.splice(0)) await server.close();
});

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc',
    kind: 'custom',
    protocol: 'openai',
    enabled: true,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    ...patch,
  };
}

function request(
  overrides: Partial<ProtocolRequest> & { entry: ServiceEntry },
): ProtocolRequest {
  return {
    body: {},
    values: {},
    format: 'wav',
    timeoutMs: 5000,
    fetch: (input, init) => fetch(input, init),
    secret: () => '',
    ...overrides,
  };
}

describe('openai protocol', () => {
  it('POST /v1/audio/speech,带上游令牌并读音频', async () => {
    const bytes = wavBytes(0.5);
    const server = await upstream((_req, res) => audio(res, bytes));
    const res = await openaiProtocol.speech(request({
      entry: entry({ baseUrl: server.url, secretName: 'UPSTREAM_TOKEN' }),
      body: { model: 'tts-1', input: 'hi', voice: 'alloy', response_format: 'wav' },
      secret: (name) => (name === 'UPSTREAM_TOKEN' ? 'k-123' : ''),
    }));
    const [recorded] = server.requests;
    expect(recorded?.method).toBe('POST');
    expect(recorded?.url).toBe('/v1/audio/speech');
    expect(recorded?.headers.authorization).toBe('Bearer k-123');
    expect(JSON.parse(recorded!.body)).toEqual({
      model: 'tts-1', input: 'hi', voice: 'alloy', response_format: 'wav',
    });
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(bytes));
    expect(res.mime).toBe('audio/wav');
    expect(res.seconds).toBe(0.5);
  });

  it('baseUrl 已经带 /v1 时不重复拼', async () => {
    const server = await upstream((_req, res) => audio(res, wavBytes(0.1)));
    await openaiProtocol.speech(request({
      entry: entry({ baseUrl: `${server.url}/v1` }),
      body: { input: 'hi' },
    }));
    expect(server.requests[0]?.url).toBe('/v1/audio/speech');
  });

  it('上游非音频与错误正文都变成 upstream 错误', async () => {
    const bad = await upstream((_req, res) => json(res, 500, { error: 'boom' }));
    await expect(openaiProtocol.speech(request({
      entry: entry({ baseUrl: bad.url }),
      body: { input: 'hi' },
    }))).rejects.toMatchObject({
      kind: 'upstream',
      status: 502,
      message: expect.stringContaining('upstream 500'),
    });

    const html = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>nope</html>');
    });
    await expect(openaiProtocol.speech(request({
      entry: entry({ baseUrl: html.url }),
      body: { input: 'hi' },
    }))).rejects.toBeInstanceOf(ServiceError);
  });

  it('超时是 timeout 错误', async () => {
    const slow = await upstream(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      audio(res, wavBytes(0.1));
    });
    await expect(openaiProtocol.speech(request({
      entry: entry({ baseUrl: slow.url }),
      body: { input: 'hi' },
      timeoutMs: 30,
    }))).rejects.toMatchObject({ kind: 'timeout', status: 504 });
  });

  it('上游回 application/octet-stream 时按请求格式给音频类型', async () => {
    const bytes = wavBytes(0.1);
    const server = await upstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
      });
      res.end(Buffer.from(bytes));
    });
    const wav = await openaiProtocol.speech(request({
      entry: entry({ baseUrl: server.url }),
      body: { input: 'hi' },
      format: 'wav',
    }));
    expect(wav.mime).toBe('audio/wav');
    const mp3 = await openaiProtocol.speech(request({
      entry: entry({ baseUrl: server.url }),
      body: { input: 'hi' },
      format: 'mp3',
    }));
    expect(mp3.mime).toBe('audio/mpeg');
  });

  it('回应体停顿也计入超时', async () => {
    const slow = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      setTimeout(() => {
        try { res.end(Buffer.from(wavBytes(0.1))); } catch { /* 已经断开 */ }
      }, 300).unref();
    });
    await expect(openaiProtocol.speech(request({
      entry: entry({ baseUrl: slow.url }),
      body: { input: 'hi' },
      timeoutMs: 30,
    }))).rejects.toMatchObject({ kind: 'timeout', status: 504 });
  });
});

describe('audiocpp protocol', () => {
  it('speech 原样转交 options', async () => {
    const server = await upstream((_req, res) => audio(res, wavBytes(0.2)));
    await audiocppProtocol.speech(request({
      entry: entry({ protocol: 'audiocpp', baseUrl: server.url }),
      body: {
        input: 'hi',
        response_format: 'wav',
        options: { template_name: 'freeform', instruct: 'softly' },
      },
    }));
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      input: 'hi',
      response_format: 'wav',
      options: { template_name: 'freeform', instruct: 'softly' },
    });
  });

  it('listVoices 解析字符串与对象项', async () => {
    const server = await upstream((_req, res) => json(res, 200, {
      voices: ['alpha', { id: 'beta', label: 'Beta' }],
    }));
    const voices = await audiocppProtocol.listVoices!({
      entry: entry({ protocol: 'audiocpp', baseUrl: server.url }),
      model: 'ming3',
      timeoutMs: 5000,
      fetch: (input, init) => fetch(input, init),
      secret: () => '',
    } satisfies VoiceListRequest);
    expect(voices).toEqual([
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'Beta' },
    ]);
    expect(server.requests[0]?.url).toBe('/v1/audio/voices?model=ming3');
  });
});

describe('custom protocol', () => {
  it('模板请求体、头里的密钥与 base64 回应', async () => {
    const bytes = wavBytes(0.25);
    const server = await upstream((_req, res) => json(res, 200, {
      audio: Buffer.from(bytes).toString('base64'),
      mime: 'audio/wav',
    }));
    const res = await customProtocol.speech(request({
      entry: entry({
        protocol: 'custom',
        baseUrl: `${server.url}/custom/tts`,
        secretName: 'UPSTREAM_TOKEN',
        options: {
          method: 'POST',
          headers: { 'X-Api-Key': '${KEY}' },
          body: '{"say":"{{text}}","rate":{{speed}},"mime":"{{format}}"}',
          response: 'base64',
        },
      }),
      body: { text: 'hi' },
      values: { text: 'hi', speed: '1.5', format: 'wav' },
      secret: () => 'secret-key',
    }));
    const recorded = server.requests[0]!;
    expect(recorded.url).toBe('/custom/tts');
    expect(recorded.headers['x-api-key']).toBe('secret-key');
    expect(recorded.headers.authorization).toBe('Bearer secret-key');
    expect(JSON.parse(recorded.body)).toEqual({ say: 'hi', rate: 1.5, mime: 'wav' });
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(bytes));
  });

  it('response=url 时再取一次音频地址', async () => {
    const bytes = wavBytes(0.1);
    const server = await upstream((req, res) => {
      if (req.url === '/custom') { json(res, 200, { result: { url: '/files/a.wav' } }); return; }
      audio(res, bytes);
    });
    const res = await customProtocol.speech(request({
      entry: entry({
        protocol: 'custom',
        baseUrl: `${server.url}/custom`,
        options: { response: 'url', audioPath: 'result.url' },
      }),
      body: { text: 'hi' },
    }));
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(bytes));
    expect(server.requests.map((item) => item.url)).toEqual(['/custom', '/files/a.wav']);
  });
});

describe('sing protocol', () => {
  it('POST /sing 并读 base64 回应', async () => {
    const bytes = wavBytes(0.5);
    const server = await upstream((_req, res) => json(res, 200, {
      audioBase64: Buffer.from(bytes).toString('base64'),
      mime: 'audio/wav',
    }));
    const res = await singProtocol.sing!(request({
      entry: entry({ protocol: 'sing', baseUrl: server.url }),
      body: { lyrics: 'la la', model: 'song-1' },
    }));
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ lyrics: 'la la', model: 'song-1' });
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(bytes));
    expect(res.mime).toBe('audio/wav');
  });

  it('接受音频字节回应', async () => {
    const bytes = wavBytes(0.3);
    const server = await upstream((_req, res) => audio(res, bytes));
    const res = await singProtocol.sing!(request({
      entry: entry({ protocol: 'sing', baseUrl: server.url }),
      body: { lyrics: 'la' },
    }));
    expect(Buffer.from(res.bytes)).toEqual(Buffer.from(bytes));
  });

  it('sing 遵守 requestTimeoutSec,不另设下限', async () => {
    const slow = await upstream(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      audio(res, wavBytes(0.1));
    });
    await expect(singProtocol.sing!(request({
      entry: entry({ protocol: 'sing', baseUrl: slow.url }),
      body: { lyrics: 'la' },
      timeoutMs: 30,
    }))).rejects.toMatchObject({ kind: 'timeout', status: 504 });
  });
});

describe('WAV duration', () => {
  it('读出 PCM16 WAV 的时长;非 WAV 返回 undefined', () => {
    expect(wavSeconds(wavBytes(2))).toBe(2);
    expect(wavSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
