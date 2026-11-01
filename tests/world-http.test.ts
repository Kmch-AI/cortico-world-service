import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_DEFAULTS } from '../src/config.ts';
import { ServiceWorld } from '../src/world.ts';
import type { ServiceConfigSection, ServiceEntry } from '../src/types.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { quietLogger } from './helpers/quiet.ts';
import { audio, json, startUpstream, type Upstream } from './helpers/upstream.ts';
import { wavBytes } from './helpers/wav.ts';

const worlds: ServiceWorld[] = [];
const dirs: string[] = [];
const servers: Upstream[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function ttsUpstream(): Promise<Upstream> {
  const server = await startUpstream((req, res) => {
    if (req.url === '/health') json(res, 200, { status: 'ok', models: 2, backend: 'test' });
    else if (req.url === '/v1/models') {
      json(res, 200, { object: 'list', data: [{ id: 'tts-1', name: 'Test TTS' }] });
    } else if (req.url?.startsWith('/v1/audio/voices')) {
      json(res, 200, { voices: ['alloy', 'nova'] });
    } else if (req.url === '/v1/audio/speech') {
      audio(res, wavBytes(0.5));
    } else if (req.url === '/sing') {
      audio(res, wavBytes(0.25));
    } else {
      json(res, 404, { error: 'no route' });
    }
  });
  servers.push(server);
  return server;
}

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'service-http-'));
  dirs.push(dir);
  return dir;
}

function build(
  entries: ServiceEntry[],
  patch: Partial<ServiceConfigSection> = {},
  secret: (name: string) => string = () => '',
): ServiceWorld {
  const cfg: ServiceConfigSection = {
    ...SERVICE_DEFAULTS,
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutSec: 5,
    services: entries,
    ...patch,
  };
  const world = new ServiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: dataDir(),
    log: quietLogger,
    secret,
  });
  worlds.push(world);
  return world;
}

function speechEntry(url: string): ServiceEntry {
  return {
    id: 'tts',
    name: 'Test TTS',
    type: 'audiocpp',
    enabled: true,
    endpoint: url,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    secretName: 'UPSTREAM_TOKEN',
  };
}

function singEntry(url: string): ServiceEntry {
  return {
    id: 'singer',
    name: 'Singer',
    type: 'sing',
    enabled: true,
    endpoint: url,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    models: ['song-1'],
    options: { path: '/sing' },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

describe('service World HTTP gateway', () => {
  it('启动网关、聚合目录、代理 speech 与 sing', async () => {
    const upstream = await ttsUpstream();
    const world = build(
      [speechEntry(upstream.url), singEntry(upstream.url)],
      {},
      (name) => (name === 'UPSTREAM_TOKEN' ? 'up-token' : ''),
    );
    await world.start(new FakeHost());

    const status = world.gatewayStatus();
    expect(status.status).toBe('ok');
    expect(status.ready).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(status.models).toBe(2);
    await waitFor(() => upstream.requests.some((item) => item.url.startsWith('/v1/audio/voices')));

    const base = `http://127.0.0.1:${status.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { status: string; ready: boolean; models: number; services: unknown[] };
    expect(healthBody).toMatchObject({ status: 'ok', ready: true, models: 2 });
    expect(healthBody.services).toHaveLength(2);

    const models = await (await fetch(`${base}/v1/models`)).json() as {
      data: Array<{ id: string; service: string; display_name?: string }>;
    };
    expect(models.data.map((model) => `${model.service}:${model.id}`).sort()).toEqual([
      'singer:song-1', 'tts:tts-1',
    ]);

    const voices = await (await fetch(`${base}/v1/audio/voices?model=tts-1`)).json() as {
      object: string; model: string; voices: string[];
    };
    expect(voices).toMatchObject({ object: 'list', model: 'tts-1', voices: ['alloy', 'nova'] });

    const speech = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'wav',
      }),
    });
    expect(speech.status).toBe(200);
    expect(speech.headers.get('content-type')).toBe('audio/wav');
    expect((await speech.arrayBuffer()).byteLength).toBe(wavBytes(0.5).length);
    const speechCall = upstream.requests.find((item) => item.url === '/v1/audio/speech')!;
    expect(speechCall.headers.authorization).toBe('Bearer up-token');
    expect(JSON.parse(speechCall.body)).toEqual({
      model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'wav',
    });

    const sing = await fetch(`${base}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: 'la la' }),
    });
    expect(sing.status).toBe(200);
    const singCall = upstream.requests.find((item) => item.url === '/sing')!;
    expect(JSON.parse(singCall.body)).toEqual({ lyrics: 'la la' });

    await world.stop();
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it('audiocpp 只列真实模型,spec 只补参数,/v1/models 带 parameters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiocpp-svc-'));
    dirs.push(dir);
    const specsDir = join(dir, 'model_specs');
    mkdirSync(specsDir);
    writeFileSync(join(dir, 'server.json'), JSON.stringify({
      models: [
        {
          id: 'ming3-tts',
          family: 'ming3_tts',
          task: 'tts',
          voice_presets: { '4016': {} },
          default_voice_preset: '4016',
        },
        {
          id: 'index-tts2',
          family: 'index_tts2',
          task: 'tts',
          voice_presets: { '4016': {} },
          default_voice_preset: '4016',
        },
      ],
    }));
    writeFileSync(join(specsDir, 'ming3_tts.json'), JSON.stringify({
      family: 'ming3_tts',
      display_name: 'Ming 3.0 TTS 0.5B',
      category: 'tts',
      tasks: ['tts', 'clone'],
      options: { request: [{ name: 'template_name', type: 'enum', values: ['tts', 'basic'] }] },
    }));
    writeFileSync(join(specsDir, 'index_tts2.json'), JSON.stringify({
      family: 'index_tts2',
      display_name: 'IndexTTS2',
      category: 'tts',
      tasks: ['tts', 'clone'],
      options: {
        request: [
          { name: 'text', type: 'string' },
          { name: 'language', type: 'string' },
          {
            name: 'emotion_alpha', type: 'float', description: 'Blend.', min: 0, max: 1, default: 1,
          },
          { name: 'top_k', type: 'int', min: 1, default: 30 },
        ],
      },
    }));
    writeFileSync(join(specsDir, 'chatterbox.json'), JSON.stringify({
      family: 'chatterbox', display_name: 'Chatterbox', category: 'tts',
    }));

    const upstream = await startUpstream((req, res) => {
      if (req.url === '/health') json(res, 200, { status: 'ok', models: 2 });
      else if (req.url === '/v1/models') {
        json(res, 200, { object: 'list', data: [{ id: 'ming3-tts' }, { id: 'index-tts2' }] });
      } else if (req.url?.startsWith('/v1/audio/voices')) {
        json(res, 200, { voices: ['4016'] });
      } else if (req.url === '/v1/audio/speech') {
        audio(res, wavBytes(0.5));
      } else {
        json(res, 404, { error: 'no route' });
      }
    });
    servers.push(upstream);

    const world = build([{ ...speechEntry(upstream.url), serverDir: dir }]);
    await world.start(new FakeHost());
    const base = `http://127.0.0.1:${world.gatewayStatus().port}`;

    const models = await (await fetch(`${base}/v1/models`)).json() as {
      data: Array<{
        id: string; display_name?: string; tasks: string[]; voices: string[];
        parameters?: Array<{ name: string; type: string; min?: number; max?: number }>;
      }>;
    };
    expect(models.data.map((model) => model.id)).toEqual(['ming3-tts', 'index-tts2']);
    const index = models.data.find((model) => model.id === 'index-tts2')!;
    expect(index).toMatchObject({
      display_name: 'IndexTTS2',
      tasks: ['tts', 'clone'],
      voices: ['4016'],
    });
    expect(index.parameters).toHaveLength(18);
    expect(index.parameters?.[0]).toMatchObject({ name: 'emotion_alpha', type: 'float', min: 0, max: 1 });
    expect(index.parameters?.some((item) => item.name === 'text_chunk_mode')).toBe(true);

    const speech = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'index-tts2',
        input: 'hello',
        voice: '4016',
        emotion: 'happy',
        options: { emotion_alpha: 0.5, text_chunk_mode: 'tag_aware' },
      }),
    });
    expect(speech.status).toBe(200);
    const call = upstream.requests.filter((item) => item.url === '/v1/audio/speech').at(-1)!;
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: 'hello', voice: '4016', response_format: 'wav',
    });
    expect(body.options).toMatchObject({
      emotion_alpha: 0.5,
      use_emotion_text: true,
      emotion_text: 'happy',
      top_k: 30,
      text_chunk_mode: 'tag_aware',
    });

    await world.stop();
  });

  it('请求不带 model 时用 defaultSpeechModel,即使目录里没有它', async () => {
    const upstream = await ttsUpstream();
    const world = build([speechEntry(upstream.url)], { defaultSpeechModel: 'fallback-model' });
    await world.start(new FakeHost());
    const base = `http://127.0.0.1:${world.gatewayStatus().port}`;
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    expect(res.status).toBe(200);
    const call = upstream.requests.find((item) => item.url === '/v1/audio/speech')!;
    expect(JSON.parse(call.body).model).toBe('fallback-model');
  });

  it('未知模型在没有歧义时透传给唯一服务,多服务时 404', async () => {
    const upstream = await ttsUpstream();
    const world = build([speechEntry(upstream.url)]);
    await world.start(new FakeHost());
    const base = `http://127.0.0.1:${world.gatewayStatus().port}`;

    const unknown = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'other-model', input: 'hi' }),
    });
    expect(unknown.status).toBe(200);
    expect(JSON.parse(upstream.requests.find((item) => item.url === '/v1/audio/speech')!.body).model)
      .toBe('other-model');

    const ambiguous = build([speechEntry(upstream.url), { ...speechEntry(upstream.url), id: 'tts-2' }]);
    await ambiguous.start(new FakeHost());
    const base2 = `http://127.0.0.1:${ambiguous.gatewayStatus().port}`;
    const rejected = await fetch(`${base2}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'other-model', input: 'hi' }),
    });
    expect(rejected.status).toBe(404);
  });
});

describe('service World fail-closed auth', () => {
  it('非回环地址没有令牌时拒绝启动网关', async () => {
    const world = build([], { host: '0.0.0.0' });
    await world.start(new FakeHost());
    const status = world.gatewayStatus();
    expect(status.status).toBe('error');
    expect(status.detail).toContain('tokenSecret');
    expect(status.ready).toBe(false);
    await world.stop();
  });

  it('令牌变量名存在但值为空时拒绝启动', async () => {
    const world = build([], { tokenSecret: 'SVC_TOKEN' });
    await world.start(new FakeHost());
    expect(world.gatewayStatus().status).toBe('error');
    expect(world.gatewayStatus().detail).toContain('SVC_TOKEN');
    await world.stop();
  });

  it('配置令牌后要求 Bearer;health 也需要', async () => {
    const world = build([], { tokenSecret: 'SVC_TOKEN' }, (name) => (name === 'SVC_TOKEN' ? 'abc' : ''));
    await world.start(new FakeHost());
    const status = world.gatewayStatus();
    expect(status.status).toBe('degraded');
    expect(status.ready).toBe(false);
    const base = `http://127.0.0.1:${status.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const good = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer abc' } });
    expect(good.status).toBe(200);
    await world.stop();
  });
});
