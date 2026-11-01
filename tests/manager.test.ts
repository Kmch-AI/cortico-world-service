import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Manager } from '../src/manager.ts';
import type { ServiceEntry } from '../src/types.ts';
import { quietLogger } from './helpers/quiet.ts';
import { multiHarness, serviceEntry } from './helpers/service.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'service-manager-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function services(): ServiceEntry[] {
  return [
    serviceEntry({
      id: 'alpha',
      name: 'Alpha',
      type: 'custom',
      endpoint: 'http://127.0.0.1:9001',
      serverDir: '',
      binary: 'C:/bin/alpha.exe',
      args: '--port 9001',
      options: {},
    }),
    serviceEntry({
      id: 'beta',
      name: 'Beta',
      type: 'custom',
      endpoint: 'http://127.0.0.1:9002',
      serverDir: '',
      binary: 'C:/bin/beta.exe',
      args: '--port 9002',
      options: {},
    }),
  ];
}

describe('Manager', () => {
  it('按配置顺序启动多个条目,逆序停止', async () => {
    const entries = services();
    const h = multiHarness(entries, { healthyOnLaunch: true });
    const manager = new Manager({
      services: () => entries,
      dataDir: tempDir(),
      log: quietLogger,
      deps: h.deps,
    });

    const started = await manager.startAll();
    expect(started.map((status) => status.phase)).toEqual(['online', 'online']);
    expect(h.launches.map((launch) => launch.command)).toEqual(['C:/bin/alpha.exe', 'C:/bin/beta.exe']);
    expect(manager.status().map((status) => status.entry.id)).toEqual(['alpha', 'beta']);

    await manager.stopAll();
    expect(h.children.every((child) => child.killed)).toBe(true);
    const stopped = h.phases.filter((status) => status.phase === 'off').map((status) => status.entry.id);
    expect(stopped).toEqual(['beta', 'alpha']);
    expect(manager.status().every((status) => status.phase === 'off')).toBe(true);
  });

  it('只拉起 enabled 且 autoStart 的条目,其余只探活', async () => {
    const entries = [
      services()[0]!,
      { ...services()[1]!, autoStart: false },
      { ...serviceEntry({
        id: 'gamma',
        name: 'Gamma',
        type: 'custom',
        endpoint: 'http://127.0.0.1:9003',
        binary: 'C:/bin/gamma.exe',
        serverDir: '',
        options: {},
      }), enabled: false },
    ];
    const h = multiHarness(entries, { adopt: ['beta'], healthyOnLaunch: true });
    const manager = new Manager({
      services: () => entries,
      dataDir: tempDir(),
      log: quietLogger,
      deps: h.deps,
    });

    await manager.startAll();
    expect(h.launches.map((launch) => launch.command)).toEqual(['C:/bin/alpha.exe']);
    const statuses = manager.status();
    expect(statuses[0]?.phase).toBe('online');
    expect(statuses[1]?.phase).toBe('online');
    expect(statuses[2]?.phase).toBe('off');
    expect(statuses[2]?.detail).toBe('disabled');
  });

  it('按 id 重启会先停再起', async () => {
    const entries = services();
    const h = multiHarness(entries, { healthyOnLaunch: true });
    const manager = new Manager({
      services: () => entries,
      dataDir: tempDir(),
      log: quietLogger,
      deps: h.deps,
    });

    await manager.startAll();
    expect(h.launches).toHaveLength(2);
    h.setHealthy('alpha', false);
    const restarted = await manager.restart('alpha');
    expect(restarted?.phase).toBe('online');
    expect(h.launches.map((launch) => launch.command)).toEqual([
      'C:/bin/alpha.exe', 'C:/bin/beta.exe', 'C:/bin/alpha.exe',
    ]);
    expect(manager.statusOf('alpha')?.phase).toBe('online');
  });

  it('写回走 persist 回调,并让状态跟随新条目', async () => {
    const entries = services();
    const saved: ServiceEntry[][] = [];
    const manager = new Manager({
      services: () => entries,
      dataDir: tempDir(),
      log: quietLogger,
      persist: (next) => {
        saved.push(next);
        entries.splice(0, entries.length, ...next);
      },
    });

    await manager.setServices([{ ...entries[0]!, name: 'Renamed' }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.map((entry) => entry.id)).toEqual(['alpha']);
    expect(manager.status()).toHaveLength(1);
    expect(manager.status()[0]?.entry.name).toBe('Renamed');
  });

  it('logs 返回文件尾部,文件不存在时为空', async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'service-alpha.log'), ['one', 'two', 'three', ''].join('\n'));
    const manager = new Manager({
      services: services(),
      dataDir,
      log: quietLogger,
    });
    expect(await manager.logs('alpha', 2)).toBe('two\nthree');
    expect(await manager.logs('missing')).toBe('');
  });
});
