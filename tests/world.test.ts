import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { AUDIOCPP } from '../src/definition.ts';
import { AudiocppWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { harness } from './helpers/audiocpp.ts';
import { quietLogger } from './helpers/quiet.ts';

const worlds: AudiocppWorld[] = [];

function make(patch: Parameters<typeof harness>[0] = {}, opts: Parameters<typeof harness>[1] = {}): {
  world: AudiocppWorld;
  h: ReturnType<typeof harness>;
} {
  const h = harness(patch, opts);
  const world = new AudiocppWorld({
    cfg: h.cfg,
    timezone: 'UTC',
    dataDir: 'C:/data',
    log: quietLogger,
    deps: h.deps,
  });
  worlds.push(world);
  return { world, h };
}

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop().catch(() => {});
});

describe('audiocpp World', () => {
  it('干装载不报失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audiocpp-dry-'));
    try {
      const report = await dryMountWorld(AUDIOCPP, { scratchDir: dir });
      expect(report.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有工具,也不进环境提示词', async () => {
    const { world } = make();
    expect(world.tools()).toEqual([]);
    expect(world.envPromptVars()).toBeNull();
  });

  it('启动前灯是 offline', () => {
    const { world } = make();
    const ui = world.webUi('zh');
    expect(ui.label).toBe('audiocpp');
    expect(ui.lamps?.[0]?.state).toBe('offline');
  });

  it('autoStart=false 时只探活外部服务并发状态事件', async () => {
    const { world } = make({ autoStart: false }, { adopt: true });
    const host = new FakeHost();
    await world.start(host);
    expect(world.webUi('zh').lamps?.[0]?.state).toBe('online');
    const event = host.events.find((e) => e.type === 'audiocpp.started');
    expect(event).toBeTruthy();
    expect(host.pushOpts[host.events.indexOf(event!)]).toEqual({ deliver: false });
    await world.stop();
    expect(host.events.some((e) => e.type === 'audiocpp.stopped')).toBe(true);
  });

  it('默认配置没有服务目录时保持 off,不抛错', async () => {
    const { world } = make({ autoStart: true, serverDir: '' }, { healthFails: 1 });
    const host = new FakeHost();
    await world.start(host);
    expect(world.webUi('zh').lamps?.[0]?.state).toBe('offline');
  });

  it('在线且启用 WebUI 时给链接', async () => {
    const { world } = make({ autoStart: false, ui: true }, { adopt: true });
    await world.start(new FakeHost());
    const links = world.webUi('zh').links ?? [];
    expect(links[0]?.href).toBe('http://127.0.0.1:8000');
  });
});
