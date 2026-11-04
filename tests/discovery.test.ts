import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverJsonPath } from '../src/entry.ts';
import { ModelCatalog, type CatalogOptions } from '../src/profiles/discover.ts';
import type { ServiceEntry } from '../src/types.ts';
import { quietLogger } from './helpers/quiet.ts';

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc',
    name: 'svc',
    type: 'audiocpp',
    endpoint: 'http://127.0.0.1:8000',
    enabled: true,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    ...patch,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FakeNet {
  fetch: typeof fetch;
  calls: Array<{ url: string; authorization?: string }>;
  fail: boolean;
}

function fakeNet(models: unknown, voices: Record<string, unknown[]> = {}): FakeNet {
  const net: FakeNet = {
    fail: false,
    calls: [],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      net.calls.push({
        url,
        ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}),
      });
      if (net.fail) throw new Error('upstream down');
      if (/\/v1\/models$/.test(url)) return jsonResponse(models);
      if (url.includes('/v1/audio/voices')) {
        const model = new URL(url).searchParams.get('model') ?? '';
        return jsonResponse({ voices: voices[model] ?? [] });
      }
      return new Response('no', { status: 404 });
    }) as typeof fetch,
  };
  return net;
}

function fakeFiles(
  files: Record<string, string>,
  dirs: Record<string, string[]> = {},
  sizes: Record<string, number> = {},
): CatalogOptions {
  return {
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    readdir: async (path) => {
      const list = dirs[path];
      if (!list) throw new Error(`ENOENT ${path}`);
      return list;
    },
    stat: async (path) => ({ size: sizes[path] ?? files[path]?.length ?? 0 }),
    now: () => 1000,
    log: quietLogger,
  };
}

describe('ModelCatalog discovery', () => {
  it('GET /v1/models + /v1/audio/voices,带上游令牌', async () => {
    const net = fakeNet(
      { object: 'list', data: [{ id: 'ming3', name: 'Ming 3', voices: ['v1'] }, { id: 'qwen' }] },
      { ming3: ['v1', 'v2'] },
    );
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      secret: (name) => (name === 'UP' ? 'tok' : ''),
      log: quietLogger,
      now: () => 1000,
    });
    const item = entry({ secretName: 'UP' });
    const found = await catalog.refresh(item);
    expect(found.stale).toBe(false);
    expect(found.detail).toBe('2 models');
    expect(found.models.map((model) => model.id)).toEqual(['ming3', 'qwen']);
    expect(found.models[0]).toMatchObject({
      label: 'Ming 3', voices: ['v1', 'v2'], tasks: ['tts'], service: 'svc', source: 'api',
    });
    expect(found.models[1]?.voices).toEqual([]);
    expect(net.calls.every((call) => call.authorization === 'Bearer tok')).toBe(true);
    expect(catalog.find('MING3', [item])?.model.id).toBe('ming3');
    expect(catalog.models([item])).toHaveLength(2);
  });

  it('发现失败保留上次目录并标 stale', async () => {
    const net = fakeNet({ data: [{ id: 'ming3' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger, now: () => 1000 });
    const item = entry();
    expect((await catalog.refresh(item)).models.map((model) => model.id)).toEqual(['ming3']);
    net.fail = true;
    const stale = await catalog.refresh(item);
    expect(stale.stale).toBe(true);
    expect(stale.detail).toContain('discovery failed');
    expect(stale.models.map((model) => model.id)).toEqual(['ming3']);
    expect(catalog.get('svc')?.stale).toBe(true);
  });

  it('openai/custom/sing 条目显式 models 时不再请求 /v1/models', async () => {
    const net = fakeNet({ data: [{ id: 'should-not-appear' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ type: 'openai', models: ['alpha', 'beta'] }));
    expect(found.models.map((model) => model.id)).toEqual(['alpha', 'beta']);
    expect(net.calls.some((call) => /\/v1\/models$/.test(call.url))).toBe(false);
  });

  it('llamacpp 现在有 HTTP 协议,会读 /v1/models', async () => {
    const net = fakeNet({ data: [{ id: 'llm' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ type: 'llamacpp' }));
    expect(found.detail).toBe('1 models');
    expect(found.models.map((model) => model.id)).toEqual(['llm']);
    expect(found.models[0]?.tasks).toEqual(['embeddings', 'rerank']);
    expect(net.calls.some((call) => /\/v1\/models$/.test(call.url))).toBe(true);
  });

  it('llamacpp 条目的 tasks 覆盖模型目录，StartLux 标成 systemone', async () => {
    const net = fakeNet({ data: [{ id: 'StartLux-Decision-v1.1-0.8B-Instant' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ type: 'llamacpp', tasks: ['systemone'] }));
    expect(found.models[0]?.tasks).toEqual(['systemone']);
  });

  it('外部 systemone 条目的默认任务是 systemone', async () => {
    const net = fakeNet({ data: [{ id: 'jev' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ type: 'systemone' }));
    expect(found.models[0]?.tasks).toEqual(['systemone']);
  });

  it('上游 chat 任务不覆盖外部 systemone 的路由能力', async () => {
    const net = fakeNet({ data: [{ id: 'jev', tasks: ['chat'] }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ type: 'systemone' }));
    expect(found.models[0]?.tasks).toEqual(['systemone', 'chat']);
  });
});

describe('audiocpp server.json + specs metadata', () => {
  const serverDir = 'C:/svc';
  const serverPath = serverJsonPath({ serverDir })!;
  const specsDir = join(serverDir, 'model_specs');
  const mingSpec = join(specsDir, 'ming3_tts.json');
  const indexSpec = join(specsDir, 'index_tts2.json');
  const extraSpec = join(specsDir, 'chatterbox.json');

  const serverJson = JSON.stringify({
    models: [
      {
        id: 'ming3-tts',
        family: 'ming3_tts',
        task: 'tts',
        voice_presets: { '4016': {}, '7': {} },
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
  });
  const mingMeta = JSON.stringify({
    family: 'ming3_tts',
    display_name: 'Ming 3.0 TTS 0.5B',
    category: 'tts',
    tasks: ['tts', 'clone'],
    options: {
      request: [
        { name: 'template_name', type: 'enum', description: 'Conditioning template.', values: ['tts', 'basic'] },
        { name: 'language', type: 'string', description: 'Target language.' },
        { name: 'seed', type: 'int', description: 'Noise seed.', min: 0, default: 1895 },
      ],
    },
  });
  const indexMeta = JSON.stringify({
    family: 'index_tts2',
    display_name: 'IndexTTS2',
    category: 'tts',
    tasks: ['tts', 'clone'],
    options: {
      request: [
        { name: 'text', type: 'string' },
        { name: 'language', type: 'string' },
        {
          name: 'emotion_alpha',
          type: 'float',
          description: 'Emotion conditioning blend strength.',
          min: 0,
          max: 1,
          default: 1,
        },
        { name: 'use_emotion_text', type: 'bool', description: 'Use text-derived emotion conditioning.', default: false },
        { name: 'text_chunk_mode', type: 'enum', values: ['default', 'tag_aware'], default: 'default' },
      ],
    },
  });

  function audiocppFiles(
    files: Record<string, string>,
    dirs: Record<string, string[]> = {},
  ): CatalogOptions {
    return fakeFiles(files, dirs, { [extraSpec]: 3 * 1024 * 1024 });
  }

  it('只列 server.json 与 /v1/models 的模型,spec 只补元数据', async () => {
    const net = fakeNet({
      object: 'list',
      data: [{ id: 'ming3-tts' }, { id: 'index-tts2' }],
    });
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      log: quietLogger,
      ...audiocppFiles({
        [serverPath]: serverJson,
        [mingSpec]: mingMeta,
        [indexSpec]: indexMeta,
        [extraSpec]: JSON.stringify({
          family: 'chatterbox',
          display_name: 'Chatterbox',
          category: 'tts',
          tasks: ['tts'],
        }),
      }, {
        [specsDir]: [basename(mingSpec), basename(indexSpec), basename(extraSpec)],
      }),
    });
    // 配置里的 models 不能把不存在的模型塞进 audiocpp 目录。
    const found = await catalog.refresh(entry({ serverDir, models: ['ghost-model'] }));
    expect(found.models.map((model) => model.id)).toEqual(['ming3-tts', 'index-tts2']);

    const ming = found.models[0]!;
    expect(ming).toMatchObject({
      label: 'Ming 3.0 TTS 0.5B',
      tasks: ['tts', 'clone'],
      voices: ['4016', '7'],
      source: 'api',
    });
    // 音色、指令、情绪与语速由语音的模型页负责；这里暴露 Ming 自己的模板与生成参数。
    expect(ming.parameters?.map((item) => item.name)).toEqual([
      'template_name', 'language', 'instruction_schema', 'pitch', 'volume', 'max_tokens',
      'guidance_scale', 'sigma', 'temperature', 'seed', 'raw_text', 'text_chunk_size',
      'text_chunk_mode', 'trim_silence',
    ]);

    const index = found.models[1]!;
    expect(index).toMatchObject({
      label: 'IndexTTS2',
      tasks: ['tts', 'clone'],
      voices: ['4016'],
    });
    expect(index.parameters?.map((item) => item.name)).toEqual([
      'emotion_alpha', 'emotion_vector', 'use_random_emotion',
      'interval_silence_ms', 'do_sample', 'top_p', 'top_k', 'temperature', 'length_penalty',
      'num_beams', 'repetition_penalty', 'max_tokens', 'duration_scale', 'seed',
      'text_chunk_size', 'text_chunk_mode',
    ]);
    expect(index.parameters?.[0]).toMatchObject({
      type: 'float', description: 'Emotion conditioning blend strength.', min: 0, max: 1, default: 1,
    });
    expect(index.parameters?.find((item) => item.name === 'text_chunk_mode')).toMatchObject({
      type: 'enum', values: ['default', 'tag_aware', 'japanese', 'endline'],
    });
  });

  it('没有 server.json 时只用 /v1/models', async () => {
    const net = fakeNet({ object: 'list', data: [{ id: 'index-tts2' }, { id: 'other' }] });
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      log: quietLogger,
      ...fakeFiles({}),
    });
    const found = await catalog.refresh(entry({ serverDir }));
    expect(found.models.map((model) => model.id)).toEqual(['index-tts2', 'other']);
    expect(found.models[0]?.label).toBeUndefined();
  });

  it('server.json 存在但 /v1/models 失败时保留声明的模型', async () => {
    const net = fakeNet({ object: 'list', data: [] });
    net.fail = true;
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      log: quietLogger,
      ...audiocppFiles({
        [serverPath]: serverJson,
        [indexSpec]: indexMeta,
      }, { [specsDir]: [basename(indexSpec)] }),
    });
    const found = await catalog.refresh(entry({ serverDir }));
    expect(found.stale).toBe(false);
    expect(found.models.map((model) => model.id)).toEqual(['ming3-tts', 'index-tts2']);
  });
});

describe('ModelCatalog seed', () => {
  it('未发现前也能从配置 models 报目录', () => {
    const catalog = new ModelCatalog({ log: quietLogger });
    const item = entry({ models: ['tts-1'] });
    catalog.seed([item]);
    expect(catalog.models([item]).map((model) => model.id)).toEqual(['tts-1']);
    expect(catalog.find('tts-1', [item])?.entry.id).toBe('svc');
    expect(catalog.find('missing', [item])).toBeUndefined();
  });

  it('禁用的条目不进目录', async () => {
    const catalog = new ModelCatalog({ log: quietLogger });
    const found = await catalog.refresh(entry({
      enabled: false, models: ['x'],
    }));
    expect(found.detail).toBe('disabled');
    expect(catalog.models([entry({ enabled: false, models: ['x'] })])).toEqual([]);
  });
});
