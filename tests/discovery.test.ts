import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelCatalog, type CatalogOptions } from '../src/profiles/discover.ts';
import type { ServiceEntry } from '../src/types.ts';
import { quietLogger } from './helpers/quiet.ts';

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc',
    kind: 'audiocpp',
    protocol: 'audiocpp',
    enabled: true,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    host: '127.0.0.1',
    port: 8000,
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

  it('条目显式 models 时不再请求 /v1/models', async () => {
    const net = fakeNet({ data: [{ id: 'should-not-appear' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ models: ['alpha', 'beta'] }));
    expect(found.models.map((model) => model.id)).toEqual(['alpha', 'beta']);
    expect(net.calls.some((call) => /\/v1\/models$/.test(call.url))).toBe(false);
  });

  it('协议 none 的条目只保留配置模型', async () => {
    const net = fakeNet({ data: [{ id: 'nope' }] });
    const catalog = new ModelCatalog({ fetch: net.fetch, log: quietLogger });
    const found = await catalog.refresh(entry({ protocol: 'none', models: ['llm'] }));
    expect(found.detail).toBe('no HTTP protocol');
    expect(found.models.map((model) => model.id)).toEqual(['llm']);
    expect(net.calls).toEqual([]);
  });
});

describe('audiocpp local specs', () => {
  const serverDir = 'C:/svc';
  const serverPath = join(serverDir, 'server.json');
  const specsDir = join(serverDir, 'model_specs');
  const specPath = join(specsDir, 'ming.json');
  const bigPath = join(specsDir, 'big.json');
  const badPath = join(specsDir, 'bad.json');

  it('读 server.json 与 model_specs,跳过超大与 schema 不符的文件', async () => {
    const net = fakeNet({ object: 'list', data: [] });
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      log: quietLogger,
      ...fakeFiles({
        [serverPath]: JSON.stringify({
          models: [{ id: 'srv-model', label: 'Server Model' }],
          voices: ['g1'],
        }),
        [specPath]: JSON.stringify({
          schema_version: 1,
          category: 'tts',
          id: 'ming3',
          name: 'Ming 3',
          voices: ['m1', { id: 'm2', label: 'M2' }],
        }),
        [bigPath]: JSON.stringify({ schema_version: 1, category: 'tts', id: 'huge' }),
        [badPath]: JSON.stringify({ schema_version: 2, category: 'tts', id: 'nope' }),
      }, { [specsDir]: [basename(specPath), basename(bigPath), basename(badPath)] }, {
        [bigPath]: 3 * 1024 * 1024,
      }),
    });
    const found = await catalog.refresh(entry({ serverDir }));
    expect(found.models.map((model) => model.id)).toEqual(['srv-model', 'ming3']);
    expect(found.models[0]?.voices).toEqual(['g1']);
    expect(found.models[1]).toMatchObject({
      label: 'Ming 3', voices: ['m1', 'm2'], tasks: ['tts'], source: 'spec',
    });
  });

  it('model_specs 里的 models 数组也能识别', async () => {
    const net = fakeNet({ object: 'list', data: [] });
    const catalog = new ModelCatalog({
      fetch: net.fetch,
      log: quietLogger,
      ...fakeFiles({
        [specPath]: JSON.stringify({
          schema_version: 1,
          category: 'tts',
          models: [{ id: 'a', voices: ['v'] }, { id: 'b' }],
        }),
      }, { [specsDir]: [basename(specPath)] }),
    });
    const found = await catalog.refresh(entry({ serverDir }));
    expect(found.models.map((model) => model.id)).toEqual(['a', 'b']);
    expect(found.models[0]?.voices).toEqual(['v']);
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
