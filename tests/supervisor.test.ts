import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/supervisor.ts';
import { quietLogger } from './helpers/quiet.ts';
import { harness } from './helpers/service.ts';

function make(
  patch: Parameters<typeof harness>[0] = {},
  opts: Parameters<typeof harness>[1] = {},
): { sup: Supervisor; h: ReturnType<typeof harness> } {
  const h = harness(patch, opts);
  const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
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

  it('按 type 预设拉起 audiocpp,参数完整', async () => {
    const { sup, h } = make({
      endpoint: 'http://127.0.0.1:8080',
      options: { backend: 'cuda', device: 1, threads: 4, idleUnloadMs: 60_000, ui: false },
      args: '--parallel-jobs',
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    const exe = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server';
    expect(launch.command).toBe(join('C:/audiocpp', exe));
    expect(launch.cwd).toBe('C:/audiocpp');
    expect(launch.args).toEqual([
      '--config', 'C:/audiocpp/server.json',
      '--host', '127.0.0.1',
      '--port', '8080',
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

  it('按 StartLux 预设拉起 systemone,参数完整', async () => {
    const { sup, h } = make({
      id: 'startlux',
      name: 'StartLux',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:8090',
      manage: true,
      serverDir: 'C:/startlux',
      options: {
        modelDir: 'D:/models/StartLux-Decision',
        llamacppUrl: 'http://127.0.0.1:18081',
        thinkMode: 'always',
        gate: 0.72,
      },
      args: '--extra 1',
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    const exe = process.platform === 'win32' ? 'startlux-decide.exe' : 'startlux-decide';
    expect(launch.command).toBe(join('C:/startlux', exe));
    expect(launch.cwd).toBe('C:/startlux');
    expect(launch.args).toEqual([
      'serve',
      '--model', 'D:/models/StartLux-Decision',
      '--backend', 'llamacpp',
      '--llamacpp-url', 'http://127.0.0.1:18081',
      '--host', '127.0.0.1',
      '--port', '8090',
      '--think-mode', 'always',
      '--gate', '0.72',
      '--extra', '1',
    ]);
    expect(sup.status().phase).toBe('online');
    await sup.stop();
  });

  it('systemone 预设缺省的可选参数不追加', async () => {
    const { sup, h } = make({
      id: 'startlux',
      name: 'StartLux',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:8090',
      manage: true,
      serverDir: 'C:/startlux',
      options: { modelDir: 'D:/models/StartLux-Decision', thinkMode: 'plain', gate: '0.5' },
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.args).toEqual([
      'serve',
      '--model', 'D:/models/StartLux-Decision',
      '--backend', 'llamacpp',
      '--llamacpp-url', 'http://127.0.0.1:8081',
      '--host', '127.0.0.1',
      '--port', '8090',
    ]);
    await sup.stop();
  });

  it('systemone 托管缺 options.modelDir 时保持 off,不拉起进程', async () => {
    const { sup, h } = make({
      id: 'startlux',
      name: 'StartLux',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:8090',
      manage: true,
      serverDir: 'C:/startlux',
      options: {},
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toEqual([]);
    expect(sup.status().phase).toBe('off');
    expect(sup.status().detail).toBe('options.modelDir is required for type systemone');
  });

  it('外部 systemone 仍只探活,不要求 modelDir', async () => {
    const { sup, h } = make({
      id: 'startlux',
      name: 'StartLux',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:8090',
      manage: false,
      serverDir: '',
      options: {},
    }, { adopt: true });
    await sup.start();
    expect(h.launches).toEqual([]);
    expect(sup.status().phase).toBe('online');
    expect(sup.status().external).toBe(true);
    await sup.stop();
  });

  it('托管 systemone 健康接口不给 backend 时,状态用 llamacpp', async () => {
    const h = harness({
      id: 'startlux',
      name: 'StartLux',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:8090',
      manage: true,
      serverDir: 'C:/startlux',
      options: { modelDir: 'D:/models/StartLux-Decision' },
    });
    let calls = 0;
    h.deps.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('no', { status: 503 });
      return new Response(JSON.stringify({ status: 'ok', models: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
    await sup.start();
    expect(sup.status().phase).toBe('online');
    expect(sup.status().backend).toBe('llamacpp');
    await sup.stop();
  });

  it('custom 条目不要求 audiocpp 字段,只用 command/args', async () => {
    const binary = process.platform === 'win32' ? 'C:/tools/tts-server.exe' : '/tools/tts-server';
    const { sup, h } = make({
      id: 'qwen-tts',
      name: 'Qwen TTS',
      type: 'custom',
      endpoint: 'http://127.0.0.1:9010',
      serverDir: '',
      binary,
      args: '--port 9010 --model qwen',
      options: {},
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.command).toBe(binary);
    expect(h.launches[0]!.args).toEqual(['--port', '9010', '--model', 'qwen']);
    expect(h.launches[0]!.cwd).toBe(process.platform === 'win32' ? 'C:/tools' : '/tools');
    expect(sup.status().phase).toBe('online');
    await sup.stop();
  });

  it('没有预设的类型缺少 binary 时保持 off', async () => {
    const { sup, h } = make({
      id: 'empty',
      name: 'Empty',
      type: 'custom',
      endpoint: 'http://127.0.0.1:9010',
      serverDir: '',
      binary: '',
      options: {},
    }, { healthFails: 1 });
    await sup.start();
    expect(h.launches).toEqual([]);
    expect(sup.status().phase).toBe('off');
    expect(sup.status().detail).toContain('binary');
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

  it('autoStart=false 时仍按 restartOnExit 退避重启', async () => {
    const { sup, h } = make({ autoStart: false }, { healthFails: 1 });
    await sup.start();
    h.child.emitExit(1);
    expect(sup.status().phase).toBe('error');
    expect(sup.status().restarts).toBe(1);
    const timer = (sup as unknown as { restartTimer: NodeJS.Timeout | null }).restartTimer;
    expect(timer).not.toBeNull();
    await sup.stop();
  });

  it('重启计数上线时不清零,稳定在线 60 秒后才清零', async () => {
    const { sup, h } = make({}, { healthFails: 1 });
    await sup.start();
    h.child.emitExit(1);
    expect(sup.status().restarts).toBe(1);

    h.healthy = true;
    await sup.start();
    expect(sup.status().restarts).toBe(1);

    h.advance(60_001);
    await sup.refresh();
    expect(sup.status().restarts).toBe(0);
    await sup.stop();
  });

  it('启动探活期间 stop,不会再变 online', async () => {
    const h = harness({}, { adopt: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const baseFetch = h.deps.fetch;
    h.deps.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await gate;
      return baseFetch(input, init);
    }) as typeof fetch;
    const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
    const starting = sup.start();
    await sup.stop();
    release();
    await starting;
    expect(sup.status().phase).toBe('off');
  });

  it('探活失败把在线改成 error', async () => {
    const { sup, h } = make({}, { adopt: true });
    await sup.start();
    h.healthy = false;
    await sup.refresh();
    expect(sup.status().phase).toBe('error');
    await sup.stop();
  });

  it('openai 条目 /health 回 404 时退回 /v1/models', async () => {
    const h = harness({
      id: 'remote',
      name: 'Remote',
      type: 'openai',
      endpoint: 'http://127.0.0.1:9010',
      manage: false,
      serverDir: '',
      options: {},
    });
    const seen: string[] = [];
    h.deps.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      if (url === 'http://127.0.0.1:9010/health') return new Response('no', { status: 404 });
      if (url === 'http://127.0.0.1:9010/v1/models') {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
    await sup.start();
    expect(seen).toEqual(['http://127.0.0.1:9010/health', 'http://127.0.0.1:9010/v1/models']);
    expect(sup.status().phase).toBe('online');
    expect(sup.status().models).toBe(2);
    await sup.stop();
  });

  it('systemone 条目 /health 回 404 时退回 /v1/models', async () => {
    const h = harness({
      id: 'systemone',
      name: 'SystemOne',
      type: 'systemone',
      endpoint: 'http://127.0.0.1:9020',
      manage: false,
      serverDir: '',
      options: {},
    });
    const seen: string[] = [];
    h.deps.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      if (url === 'http://127.0.0.1:9020/health') return new Response('no', { status: 404 });
      if (url === 'http://127.0.0.1:9020/v1/models') {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'sys-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
    await sup.start();
    expect(seen).toEqual(['http://127.0.0.1:9020/health', 'http://127.0.0.1:9020/v1/models']);
    expect(sup.status().phase).toBe('online');
    expect(sup.status().models).toBe(1);
    await sup.stop();
  });

  it('audiocpp 的 /health 回 404 时不退回 /v1/models', async () => {
    const h = harness({ manage: false }, { adopt: false });
    const seen: string[] = [];
    h.deps.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const sup = new Supervisor({ entry: h.entry, dataDir: 'C:/data', log: quietLogger, deps: h.deps });
    await sup.start();
    expect(seen).toEqual(['http://127.0.0.1:8080/health']);
    expect(sup.status().phase).toBe('error');
    await sup.stop();
  });
});
