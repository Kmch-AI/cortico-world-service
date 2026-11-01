import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/supervisor.ts';
import { quietLogger } from './helpers/quiet.ts';
import { harness } from './helpers/audiocpp.ts';

function make(patch: Parameters<typeof harness>[0] = {}, opts: Parameters<typeof harness>[1] = {}): {
  sup: Supervisor;
  h: ReturnType<typeof harness>;
} {
  const h = harness(patch, opts);
  const sup = new Supervisor({ cfg: h.cfg, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
  return { sup, h };
}

describe('Supervisor', () => {
  it('服务已经活着时接管,不重复拉起', async () => {
    const { sup, h } = make({}, { adopt: true });
    await sup.start();
    const status = sup.status();
    expect(status.phase).toBe('online');
    expect(status.external).toBe(true);
    expect(h.launches).toEqual([]);
    expect(status.models).toBe(1);
    await sup.stop();
  });

  it('按配置拉起进程,参数完整', async () => {
    const { sup, h } = make({ device: 1, threads: 4, idleUnloadMs: 60_000, ui: false, extraArgs: '--parallel-jobs' }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    expect(launch.command).toBe(join('C:/audiocpp', 'audiocpp_server.exe'));
    expect(launch.cwd).toBe('C:/audiocpp');
    expect(launch.args).toEqual([
      '--config', join('C:/audiocpp', 'server.json'),
      '--host', '127.0.0.1',
      '--port', '8000',
      '--backend', 'cuda',
      '--device', '1',
      '--threads', '4',
      '--idle-unload-ms', '60000',
      '--no-ui',
      '--parallel-jobs',
    ]);
    expect(sup.status().phase).toBe('online');
    await sup.stop();
  });

  it('serverDir 为空时保持 off,不抛错', async () => {
    const { sup } = make({ serverDir: '' }, { healthFails: 1 });
    await sup.start();
    expect(sup.status().phase).toBe('off');
    expect(sup.status().detail).toContain('serverDir');
  });

  it('manage=false 且服务不可达时记 error', async () => {
    const { sup } = make({ manage: false }, { healthFails: 1 });
    await sup.start();
    expect(sup.status().phase).toBe('error');
    expect(sup.status().detail).toContain('not reachable');
  });

  it('停止会结束子进程', async () => {
    const { sup, h } = make({}, { healthFails: 1 });
    await sup.start();
    expect(h.child.killed).toBe(false);
    await sup.stop();
    expect(h.child.killed).toBe(true);
    expect(sup.status().phase).toBe('off');
  });

  it('非预期退出记 error;关掉重启后不再拉起', async () => {
    const { sup, h } = make({ restartOnExit: false }, { healthFails: 1 });
    await sup.start();
    h.child.emitExit(1);
    expect(sup.status().phase).toBe('error');
    expect(sup.status().detail).toContain('exited');
    await sup.stop();
  });

  it('探活失败把在线改成 error', async () => {
    const { sup, h } = make({}, { adopt: true });
    await sup.start();
    h.healthy = false;
    await sup.refresh();
    expect(sup.status().phase).toBe('error');
    await sup.stop();
  });
});
