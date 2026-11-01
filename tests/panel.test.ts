import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_DEFAULTS } from '../src/config.ts';
import type {
  PanelLogs, PanelModels, PanelServiceEntry, PanelState, PanelTokenResult,
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
    name: 'Alpha',
    type: 'custom',
    endpoint: 'http://127.0.0.1:9101',
    serverDir: '',
    binary: 'C:/bin/alpha.exe',
    args: '--port 9101',
    options: {},
    ...patch,
  });
}

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('services 面板', () => {
  it('只有一个 services 面板,不再声明配置组', () => {
    const { world } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    expect(ui.panels).toEqual([
      { id: 'services', title: '服务', getMethods: ['state', 'models', 'logs'] },
    ]);
    expect(ui.config).toBeUndefined();
    expect(typeof ui.invoke).toBe('function');
    const en = world.webUi('en');
    expect(en.panels).toHaveLength(1);
    expect(en.panels?.[0]?.title).toBe('Services');
    expect(en.config).toBeUndefined();
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

  it('面板状态里没有 protocol 与 healthPath：协议与健康路径都由类型推导', async () => {
    const { world } = make({ services: [entry()] });
    const state = await world.webUi('zh').invoke!('services', 'state', []) as PanelState;
    const json = JSON.stringify(state);
    expect(json).not.toContain('protocol');
    expect(json).not.toContain('healthPath');
    expect(state.gateway).not.toHaveProperty('protocol');
    for (const service of state.services) {
      expect(service.entry).not.toHaveProperty('protocol');
      expect(service.entry).not.toHaveProperty('healthPath');
    }
  });

  it('saveGateway 校验后写回网关标量', async () => {
    const { world, cfg, saved } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const state = await ui.invoke!('services', 'saveGateway', [{
      enabled: false,
      host: '0.0.0.0',
      port: 9900,
      tokenSecret: 'NEW_TOKEN',
      allowQueryToken: true,
      requestTimeoutSec: 30,
      defaultSpeechModel: 'voice-a',
    }]) as PanelState;

    expect(saved.at(-1)).toEqual({
      enabled: false,
      host: '0.0.0.0',
      port: 9900,
      tokenSecret: 'NEW_TOKEN',
      allowQueryToken: true,
      requestTimeoutSec: 30,
      defaultSpeechModel: 'voice-a',
    });
    expect(cfg.port).toBe(9900);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.enabled).toBe(false);
    expect(cfg.tokenSecret).toBe('NEW_TOKEN');
    expect(cfg.allowQueryToken).toBe(true);
    expect(cfg.requestTimeoutSec).toBe(30);
    expect(cfg.defaultSpeechModel).toBe('voice-a');
    expect(state.gateway).toMatchObject({
      enabled: false,
      host: '0.0.0.0',
      port: 9900,
      secretName: 'NEW_TOKEN',
      allowQueryToken: true,
      requestTimeoutSec: 30,
      defaultSpeechModel: 'voice-a',
    });
  });

  it('saveGateway 拒绝坏端口、坏超时、坏变量名与未知键,且不写回', async () => {
    const { world, cfg, saved } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    for (const patch of [
      { port: 0 },
      { port: 70000 },
      { port: 1.5 },
      { port: '9883' },
      { requestTimeoutSec: 4 },
      { requestTimeoutSec: 3601 },
      { tokenSecret: 'not a name' },
      { nope: 1 },
      { enabled: 'yes' },
    ]) {
      await expect(ui.invoke!('services', 'saveGateway', [patch])).rejects.toThrow();
    }
    expect(saved).toEqual([]);
    expect(cfg.port).toBe(9883);
    expect(cfg.requestTimeoutSec).toBe(180);
    expect(cfg.tokenSecret).toBe('');
    expect(cfg.enabled).toBe(true);
  });

  it('add 忽略传入 id、返回新条目,并把完整数组写回 persist', async () => {
    const { world, cfg, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const created = await ui.invoke!('services', 'add', [{
      id: 'user-supplied',
      name: 'Beta',
      type: 'custom',
      endpoint: 'http://127.0.0.1:9102',
      enabled: true,
      manage: true,
      autoStart: false,
      restartOnExit: false,
      serverDir: '',
      binary: 'C:/bin/beta.exe',
      args: '--port 9102',
    }]) as PanelServiceEntry;

    expect(created.id).toBe('beta');
    expect(created.name).toBe('Beta');
    expect(created.tokenSet).toBe(false);
    expect(services).toHaveLength(1);
    expect(services[0]?.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(services[0]?.[1]?.autoStart).toBe(false);
    expect(cfg.services.map((item) => item.id)).toEqual(['alpha', 'beta']);
    const state = await ui.invoke!('services', 'state', []) as PanelState;
    expect(state.services.map((item) => item.entry.id)).toEqual(['alpha', 'beta']);
  });

  it('中文名与重名各自生成不冲突的 id', async () => {
    const { world, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const base = {
      type: 'custom',
      serverDir: '',
      binary: 'C:/bin/other.exe',
    };
    await ui.invoke!('services', 'add', [{ ...base, name: '本地语音', endpoint: 'http://127.0.0.1:9102' }]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha', 'custom-1']);
    await ui.invoke!('services', 'add', [{ ...base, name: 'Alpha', endpoint: 'http://127.0.0.1:9103' }]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha', 'custom-1', 'alpha-2']);
  });

  it('坏名字、坏端点与坏类型都拒绝,且不写回', async () => {
    const { world, cfg, services } = make({ services: [entry()] });
    const ui = world.webUi('zh');
    const base = {
      name: 'Other',
      type: 'custom',
      serverDir: '',
      binary: 'C:/bin/other.exe',
    };
    await expect(ui.invoke!('services', 'add', [{ ...base, endpoint: 'http://127.0.0.1:9102', name: '' }]))
      .rejects.toThrow(/name/);
    await expect(ui.invoke!('services', 'add', [{ ...base, endpoint: '' }]))
      .rejects.toThrow(/endpoint/);
    await expect(ui.invoke!('services', 'add', [{ ...base, endpoint: 'ftp://127.0.0.1:9102' }]))
      .rejects.toThrow(/http/);
    await expect(ui.invoke!('services', 'add', [{ ...base, type: 'nope', endpoint: 'http://127.0.0.1:9102' }]))
      .rejects.toThrow(/type must/);
    expect(services).toEqual([]);
    expect(cfg.services.map((item) => item.id)).toEqual(['alpha']);
  });

  it('update / reorder / remove 都写回完整数组', async () => {
    const second = entry({
      id: 'beta',
      name: 'Beta',
      binary: 'C:/bin/beta.exe',
      args: '--port 9102',
      endpoint: 'http://127.0.0.1:9102',
    });
    const { world, services } = make({ services: [entry(), second] });
    const ui = world.webUi('zh');

    await ui.invoke!('services', 'update', ['alpha', { name: 'Alpha 2', endpoint: 'http://127.0.0.1:9104' }]);
    expect(services.at(-1)?.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(services.at(-1)?.[0]?.name).toBe('Alpha 2');
    expect(services.at(-1)?.[0]?.endpoint).toBe('http://127.0.0.1:9104');
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
    const remote = entry({
      id: 'beta',
      name: 'Beta',
      binary: 'C:/bin/beta.exe',
      endpoint: 'http://127.0.0.1:9102',
    });
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
