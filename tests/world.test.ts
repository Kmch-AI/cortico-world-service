import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { SERVICE_DEFAULTS } from '../src/config.ts';
import { SERVICE } from '../src/definition.ts';
import { ServiceWorld } from '../src/world.ts';
import type { ServiceConfigSection, ServiceEntry } from '../src/types.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { harness, multiHarness, serviceEntry } from './helpers/service.ts';
import { quietLogger } from './helpers/quiet.ts';

const worlds: ServiceWorld[] = [];

/** 目录发现与协议请求在单元测试里都打不到真服务;统一回 404。 */
const offlineFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

interface Made {
  world: ServiceWorld;
  cfg: ServiceConfigSection;
  h: ReturnType<typeof harness>;
}

function make(
  patch: Parameters<typeof harness>[0] = {},
  opts: Parameters<typeof harness>[1] = {},
): Made {
  const h = harness(patch, opts);
  const cfg: ServiceConfigSection = { ...SERVICE_DEFAULTS, enabled: true, port: 0, services: [h.entry] };
  const world = new ServiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: 'C:/data',
    persist: (next) => { Object.assign(cfg, next); },
    log: quietLogger,
    deps: h.deps,
    fetch: offlineFetch,
  });
  worlds.push(world);
  return { world, cfg, h };
}

function makeMulti(entries: ServiceEntry[]): {
  world: ServiceWorld;
  cfg: ServiceConfigSection;
  h: ReturnType<typeof multiHarness>;
} {
  const cfg: ServiceConfigSection = { ...SERVICE_DEFAULTS, enabled: true, port: 0, services: entries };
  const h = multiHarness(entries, { healthyOnLaunch: true });
  const world = new ServiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: 'C:/data',
    persist: (next) => { Object.assign(cfg, next); },
    log: quietLogger,
    deps: h.deps,
    fetch: offlineFetch,
  });
  worlds.push(world);
  return { world, cfg, h };
}

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop().catch(() => {});
});

describe('service World', () => {
  it('干装载不报失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'service-dry-'));
    try {
      const report = await dryMountWorld(SERVICE, { scratchDir: dir });
      expect(report.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有工具,也不进环境提示词', () => {
    const { world } = make();
    expect(world.tools()).toEqual([]);
    expect(world.envPromptVars()).toBeNull();
  });

  it('启动前网关、服务与模型灯都是 offline', () => {
    const { world } = make();
    const ui = world.webUi('zh');
    expect(ui.label).toBe('Kmch AI · 服务');
    expect(ui.lamps?.map((lamp) => lamp.state)).toEqual(['offline', 'offline', 'offline']);
    expect(ui.badges).toEqual([
      { label: 'port', value: 0, tone: 'plain' },
      { label: 'services', value: 1, tone: 'plain' },
    ]);
    expect(SERVICE_DEFAULTS.port).toBe(9883);
    expect(world.webUi('en').label).toBe('Kmch AI · 服务');
  });

  it('autoStart=false 时只探活外部服务并发状态事件', async () => {
    const { world } = make({ autoStart: false }, { adopt: true });
    const host = new FakeHost();
    await world.start(host);
    expect(world.webUi('zh').lamps?.map((lamp) => lamp.state)).toEqual(['online', 'online', 'online']);
    const event = host.events.find((e) => e.type === 'service.started');
    expect(event).toBeTruthy();
    expect(host.pushOpts[host.events.indexOf(event!)]).toEqual({ deliver: false });
    await world.stop();
    expect(host.events.some((e) => e.type === 'service.stopped')).toBe(true);
    expect(world.webUi('zh').lamps?.[0]?.state).toBe('offline');
  });

  it('默认配置没有服务时不拉起任何进程', async () => {
    const cfg: ServiceConfigSection = { ...SERVICE_DEFAULTS, enabled: true };
    const world = new ServiceWorld({
      cfg,
      timezone: 'UTC',
      dataDir: 'C:/data',
      persist: (next) => { Object.assign(cfg, next); },
      log: quietLogger,
    });
    worlds.push(world);
    const host = new FakeHost();
    await world.start(host);
    expect(world.webUi('zh').lamps?.map((lamp) => lamp.state)).toEqual(['offline', 'offline', 'offline']);
    expect(host.events).toEqual([]);
  });

  it('默认配置没有服务目录时保持 offline,不抛错', async () => {
    const { world } = make({ serverDir: '' }, { healthFails: 1 });
    const host = new FakeHost();
    await world.start(host);
    expect(world.webUi('zh').lamps?.map((lamp) => lamp.state)).toEqual(['offline', 'offline', 'offline']);
  });

  it('在线且启用 WebUI 时给 audiocpp 链接', async () => {
    const { world } = make({ autoStart: false, options: { ui: true } }, { adopt: true });
    await world.start(new FakeHost());
    const links = world.webUi('zh').links ?? [];
    expect(links[0]?.href).toBe('http://127.0.0.1:8000');
  });

  it('多个服务按顺序启动,灯与徽标汇总', async () => {
    const entries = [
      serviceEntry({
        id: 'alpha', name: 'Alpha', type: 'custom',
        endpoint: 'http://127.0.0.1:9001',
        serverDir: '', binary: 'C:/bin/alpha.exe', args: '--port 9001', options: {},
      }),
      serviceEntry({
        id: 'beta', name: 'Beta', type: 'custom',
        endpoint: 'http://127.0.0.1:9002',
        serverDir: '', binary: 'C:/bin/beta.exe', args: '--port 9002', options: {},
      }),
    ];
    const { world, h } = makeMulti(entries);
    const host = new FakeHost();
    await world.start(host);
    expect(h.launches.map((launch) => launch.command)).toEqual(['C:/bin/alpha.exe', 'C:/bin/beta.exe']);
    const ui = world.webUi('zh');
    expect(ui.lamps?.map((lamp) => lamp.state)).toEqual(['online', 'online', 'online']);
    expect(ui.lamps?.[1]?.hint).toBe('2/2');
    expect(ui.lamps?.[2]?.hint).toBe('2');
    expect(ui.badges?.[1]).toEqual({ label: 'services', value: 2, tone: 'plain' });
    expect(host.events.filter((e) => e.type === 'service.started')).toHaveLength(2);

    await world.stop();
    expect(h.children.every((child) => child.killed)).toBe(true);
  });

  it('不声明配置组:网关标量只在 services 面板里编辑', () => {
    const { world } = make();
    const ui = world.webUi('zh');
    expect(ui.config).toBeUndefined();
    expect(ui.panels).toEqual([
      { id: 'services', title: '服务', getMethods: ['state', 'models', 'logs'] },
    ]);
  });
});
