import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_DEFAULTS } from '../src/config.ts';
import type {
  PanelLogs, PanelModels, PanelState, PanelTokenResult,
} from '../src/panel.ts';
import type { ServiceConfigSection, ServiceEntry } from '../src/types.ts';
import { ServiceWorld, type ServiceWorldOptions } from '../src/world.ts';
import { quietLogger } from './helpers/quiet.ts';
import { harness, serviceEntry } from './helpers/service.ts';

const worlds: ServiceWorld[] = [];
const dirs: string[] = [];

const offlineFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'service-panel-'));
  dirs.push(dir);
  return dir;
}

interface Made {
  world: ServiceWorld;
  cfg: ServiceConfigSection;
  saved: Array<Partial<ServiceConfigSection>>;
  services: ServiceEntry[][];
  secrets: Record<string, string>;
}

function make(
  patch: Partial<ServiceConfigSection> = {},
  opts: {
    dataDir?: string;
    secrets?: Record<string, string>;
    deps?: ServiceWorldOptions['deps'];
  } = {},
): Made {
  const cfg: ServiceConfigSection = {
    ...SERVICE_DEFAULTS,
    enabled: true,
    services: [],
    ...patch,
  };
  const saved: Array<Partial<ServiceConfigSection>> = [];
  const services: ServiceEntry[][] = [];
  const secrets: Record<string, string> = { ...opts.secrets };
  const world = new ServiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: opts.dataDir ?? 'C:/data',
    persist: (next) => {
      saved.push(next);
      if (next.services) services.push(next.services.map((entry) => ({ ...entry })));
      Object.assign(cfg, next);
    },
    secret: (name) => secrets[name] ?? '',
    storeSecret: (name, value) => { secrets[name] = value; },
    clearSecret: (name) => { delete secrets[name]; },
    log: quietLogger,
    deps: opts.deps,
    fetch: offlineFetch,
  });
  worlds.push(world);
  return { world, cfg, saved, services, secrets };
}

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return serviceEntry({
    id: 'alpha',
    label: 'Alpha',
    kind: 'custom',
    protocol: 'openai',
    serverDir: '',
    binary: 'C:/bin/alpha.exe',
    args: '--port 9101',
    port: 9101,
    options: {},
    ...patch,
  });
}

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('services 面板', () => {
  it('声明 services 面板,getMethods 只放只读方法', () => {
    const { world } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    expect(ui.panels).toEqual([
      { id: 'services', title: '服务', getMethods: ['state', 'models', 'logs'] },
    ]);
    expect(typeof ui.invoke).toBe('function');
    expect(world.webUi('en').panels?.[0]?.title).toBe('Services');
  });

  it('state 返回条目与 tokenSet,但从不带密钥值', async () => {
    const { world } = make(
      {
        tokenSecret: 'GATEWAY_TOKEN',
        services: [entry({ secretName: 'UPSTREAM_TOKEN' })],
      },
      { secrets: { GATEWAY_TOKEN: 'gw-secret-value', UPSTREAM_TOKEN: 'up-secret-value' } },
    );
    const ui = world.webUi('zh');
    const state = await ui.invoke!('services', 'state', []) as PanelState;
    expect(state.gateway.tokenSet).toBe(true);
    expect(state.gateway.secretName).toBe('GATEWAY_TOKEN');
    expect(state.services[0]?.entry.tokenSet).toBe(true);
    expect(state.services[0]?.entry.secretName).toBe('UPSTREAM_TOKEN');
    const json = JSON.stringify(state);
    expect(json).not.toContain('gw-secret-value');
    expect(json).not.toContain('up-secret-value');
  });

  it('add 把完整数组写回 persist,并更新活配置', async () => {
    const { world, cfg, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const state = await ui.invoke!('services', 'add', [{
      id: 'beta',
      label: 'Beta',
      kind: 'custom',
      protocol: 'openai',
      enabled: true,
      manage: true,
      autoStart: false,
      restartOnExit: false,
      serverDir: '',
      binary: 'C:/bin/beta.exe',
      args: '--port 9102',
      port: 9102,
    }]) as PanelState;

    expect(services).toHaveLength(1);
    expect(services[0]?.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(services[0]?.[1]?.autoStart).toBe(false);
    expect(cfg.services.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(state.services.map((item) => item.entry.id)).toEqual(['alpha', 'beta']);
  });

  it('重复端口、重复 id、坏 id 与坏端口都拒绝,且不写回', async () => {
    const { world, cfg, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const base = {
      kind: 'custom',
      protocol: 'openai',
      serverDir: '',
      binary: 'C:/bin/other.exe',
    };
    await expect(ui.invoke!('services', 'add', [{ ...base, id: 'dup-port', port: 9101 }]))
      .rejects.toThrow(/port/);
    await expect(ui.invoke!('services', 'add', [{ ...base, id: 'alpha', port: 9103 }]))
      .rejects.toThrow(/duplicate service id/);
    await expect(ui.invoke!('services', 'add', [{ ...base, id: '../evil', port: 9104 }]))
      .rejects.toThrow(/id must/);
    await expect(ui.invoke!('services', 'add', [{ ...base, id: 'bad-port', port: 70000 }]))
      .rejects.toThrow(/port/);
    expect(services).toEqual([]);
    expect(cfg.services.map((item) => item.id)).toEqual(['alpha']);
  });

  it('update / reorder / remove 都写回完整数组', async () => {
    const second = entry({
      id: 'beta',
      label: 'Beta',
      binary: 'C:/bin/beta.exe',
      args: '--port 9102',
      port: 9102,
    });
    const { world, services } = make({ services: [entry(), second] });
    const ui = world.webUi('zh');

    await ui.invoke!('services', 'update', ['alpha', { label: 'Alpha 2', port: 9104 }]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(services.at(-1)?.[0]?.label).toBe('Alpha 2');
    expect(services.at(-1)?.[0]?.port).toBe(9104);
    await expect(ui.invoke!('services', 'update', ['alpha', { id: 'other' }]))
      .rejects.toThrow(/id cannot/);

    await ui.invoke!('services', 'reorder', [['beta', 'alpha']]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['beta', 'alpha']);
    await ui.invoke!('services', 'reorder', ['beta', 1]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha', 'beta']);
    await expect(ui.invoke!('services', 'reorder', [['beta']])).rejects.toThrow(/every service id/);

    await ui.invoke!('services', 'remove', ['beta']);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha']);
    await expect(ui.invoke!('services', 'remove', ['beta'])).rejects.toThrow(/unknown service/);
  });

  it('modelProfiles 覆盖经 update 原样写回,只存覆盖', async () => {
    const { world, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    await ui.invoke!('services', 'update', ['alpha', {
      modelProfiles: { 'audiocpp-ming3': { label: 'Ming custom' } },
    }]);
    expect(services.at(-1)?.[0]?.modelProfiles).toEqual({
      'audiocpp-ming3': { label: 'Ming custom' },
    });
  });

  it('setToken 只回 tokenSet,值不进响应', async () => {
    const { world, cfg, saved, secrets } = make({
      tokenSecret: 'GATEWAY_TOKEN',
      services: [entry({ secretName: 'UPSTREAM_TOKEN' })],
    }, { secrets: { GATEWAY_TOKEN: 'old', UPSTREAM_TOKEN: 'up' } });
    const ui = world.webUi('zh');

    const result = await ui.invoke!('services', 'setToken', ['GATEWAY_TOKEN', '  fresh-token  ']) as PanelTokenResult;
    expect(result).toEqual({ tokenSet: true });
    expect(Object.keys(result)).toEqual(['tokenSet']);
    expect(JSON.stringify(result)).not.toContain('fresh-token');
    expect(secrets.GATEWAY_TOKEN).toBe('fresh-token');
    expect(saved.at(-1)).toBeUndefined();

    const state = await ui.invoke!('services', 'state', []) as PanelState;
    expect(state.gateway.tokenSet).toBe(true);

    const cleared = await ui.invoke!('services', 'setToken', ['GATEWAY_TOKEN', '']) as PanelTokenResult;
    expect(cleared).toEqual({ tokenSet: false });
    expect(secrets.GATEWAY_TOKEN).toBeUndefined();
    expect((await ui.invoke!('services', 'state', []) as PanelState).gateway.tokenSet).toBe(false);

    await expect(ui.invoke!('services', 'setToken', ['GATEWAY_TOKEN', 'a b']))
      .rejects.toThrow(/whitespace/);
    await expect(ui.invoke!('services', 'setToken', ['PATH', 'x']))
      .rejects.toThrow(/unknown token variable/);
    expect(cfg.tokenSecret).toBe('GATEWAY_TOKEN');
  });

  it('网关变量名未配置时,setToken 采用第一个名字并写回配置', async () => {
    const { world, cfg, saved } = make({ tokenSecret: '', services: [] });
    const ui = world.webUi('zh');
    const result = await ui.invoke!('services', 'setToken', ['SERVICE_TOKEN', 'secret']) as PanelTokenResult;
    expect(result).toEqual({ tokenSet: true });
    expect(cfg.tokenSecret).toBe('SERVICE_TOKEN');
    expect(saved.at(-1)).toEqual({ tokenSecret: 'SERVICE_TOKEN' });
  });

  it('logs 从数据目录取尾部', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'service-alpha.log'), ['one', 'two', 'three', ''].join('\n'));
    const { world } = make({ services: [entry()] }, { dataDir: dir });
    const ui = world.webUi('zh');
    const result = await ui.invoke!('services', 'logs', ['alpha', 2]) as PanelLogs;
    expect(result).toEqual({ id: 'alpha', lines: 2, text: 'two\nthree' });
    await expect(ui.invoke!('services', 'logs', ['missing'])).rejects.toThrow(/unknown service/);
  });

  it('models 与 discover 返回目录快照', async () => {
    const configured = entry({ models: ['voice-a', 'voice-b'] });
    const remote = entry({ id: 'beta', label: 'Beta', binary: 'C:/bin/beta.exe', port: 9102 });
    const { world } = make({ services: [configured, remote] });
    const ui = world.webUi('zh');
    const models = await ui.invoke!('services', 'models', []) as PanelModels;
    expect(models.models.map((model) => model.id)).toEqual(['voice-a', 'voice-b']);
    expect(models.services.map((item) => item.service)).toEqual(['alpha', 'beta']);

    const discovered = await ui.invoke!('services', 'discover', []) as PanelModels;
    const beta = discovered.services.find((item) => item.service === 'beta');
    expect(beta?.stale).toBe(true);
    expect(beta?.detail).toMatch(/discovery failed/);
  });

  it('probe 只探活,不拉起进程', async () => {
    const h = harness({ id: 'alpha' }, { adopt: true });
    const { world } = make({ services: [h.entry] }, { deps: h.deps });
    const ui = world.webUi('zh');
    const state = await ui.invoke!('services', 'probe', ['alpha']) as PanelState;
    expect(state.services[0]?.phase).toBe('online');
    expect(h.launches).toEqual([]);
  });
});
