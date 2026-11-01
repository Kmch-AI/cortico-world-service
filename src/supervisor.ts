/**
 * audiocpp_server 的进程管理:先探活,活着就接管;没活着按配置拉起。
 * 探活、启动、退出、重启都只改这里的状态,World 只读状态和收回调。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { AudiocppConfigSection, Phase, SupervisorStatus } from './types.ts';

export interface ChildLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', cb: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

export interface LogSink {
  write(chunk: string): void;
  close(): void;
}

export interface SupervisorDeps {
  fetch: typeof fetch;
  launch(spec: LaunchSpec): ChildLike;
  exists(path: string): boolean;
  mkdir(path: string): void;
  openLog(path: string): LogSink;
  now(): number;
  sleep(ms: number): Promise<void>;
  onPhase?(status: SupervisorStatus): void;
}

export interface SupervisorOptions {
  cfg: AudiocppConfigSection;
  dataDir: string;
  log: Logger;
  deps?: Partial<SupervisorDeps>;
}

/** 重启退避:5 秒、15 秒、60 秒。 */
const RESTART_DELAYS = [5_000, 15_000, 60_000];
const HEALTH_TIMEOUT_MS = 3000;

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of raw.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter(Boolean);
}

function defaultDeps(): SupervisorDeps {
  return {
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init)) as typeof fetch,
    launch: (spec) => spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as ChildLike,
    exists: (path) => existsSync(path),
    mkdir: (path) => { mkdirSync(path, { recursive: true }); },
    openLog: (path) => {
      const stream = createWriteStream(path, { flags: 'a' });
      return {
        write: (chunk) => { try { stream.write(chunk); } catch { /* 磁盘问题只丢日志 */ } },
        close: () => { try { stream.end(); } catch { /* 已关 */ } },
      };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export class Supervisor {
  private readonly deps: SupervisorDeps;
  private child: ChildLike | null = null;
  private childExited = false;
  private stopping = false;
  private monitor: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private sink: LogSink | null = null;
  private phase: Phase = 'off';
  private detail = 'not started';
  private models = 0;
  private backend = '';
  private onlineSince = 0;
  private restarts = 0;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: SupervisorOptions) {
    this.deps = { ...defaultDeps(), ...opts.deps };
  }

  private get cfg(): AudiocppConfigSection {
    return this.opts.cfg;
  }

  baseUrl(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  status(): SupervisorStatus {
    return {
      phase: this.phase,
      detail: this.detail,
      external: this.phase === 'online' && this.child === null,
      managed: this.cfg.manage,
      pid: this.child?.pid ?? null,
      models: this.models,
      backend: this.backend,
      baseUrl: this.baseUrl(),
      restarts: this.restarts,
    };
  }

  /** 启动:先探活,已经活着就接管;否则按配置拉起。不抛错,失败写进状态。 */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    if (this.phase === 'online' || this.phase === 'starting') return;
    this.stopping = false;
    const healthy = await this.health();
    if (this.stopping) return;
    if (healthy) {
      this.models = healthy.models;
      this.backend = healthy.backend;
      this.setPhase('online', `${healthy.backend} · ${healthy.models} models`);
      this.startMonitor();
      return;
    }
    if (this.stopping) return;
    if (!this.cfg.manage) {
      this.setPhase('error', `service is not reachable at ${this.baseUrl()}`);
      return;
    }

    const serverDir = this.cfg.serverDir.trim();
    if (!serverDir) {
      this.setPhase('off', 'serverDir is empty');
      return;
    }
    const command = this.cfg.binary.trim()
      || join(serverDir, process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server');
    if (!this.deps.exists(command)) {
      this.setPhase('error', `executable not found: ${command}`);
      return;
    }

    const args = [
      '--host', this.cfg.host,
      '--port', String(this.cfg.port),
      '--backend', this.cfg.backend,
    ];
    if (this.cfg.device >= 0) args.push('--device', String(this.cfg.device));
    if (this.cfg.threads > 0) args.push('--threads', String(this.cfg.threads));
    if (this.cfg.idleUnloadMs > 0) args.push('--idle-unload-ms', String(this.cfg.idleUnloadMs));
    if (!this.cfg.ui) args.push('--no-ui');
    args.push(...splitArgs(this.cfg.extraArgs ?? ''));
    const configPath = this.cfg.configPath.trim() || join(serverDir, 'server.json');
    if (this.deps.exists(configPath)) args.unshift('--config', configPath);

    const logPath = this.cfg.logFile.trim() || join(this.opts.dataDir, 'audiocpp.log');
    try {
      this.deps.mkdir(dirname(logPath));
      this.sink = this.deps.openLog(logPath);
      this.sink.write(`\n[${new Date(this.deps.now()).toISOString()}] ${command} ${args.join(' ')}\n`);
    } catch (error) {
      this.opts.log.warn('audiocpp 日志文件打不开', { err: error instanceof Error ? error.message : String(error) });
      this.sink = null;
    }

    this.setPhase('starting', `launching ${command}`);
    this.childExited = false;
    let child: ChildLike;
    try {
      child = this.deps.launch({ command, args, cwd: serverDir });
    } catch (error) {
      this.setPhase('error', `launch failed: ${error instanceof Error ? error.message : String(error)}`);
      this.sink?.close();
      this.sink = null;
      return;
    }
    this.child = child;
    this.pipe(child);
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.once('error', (error) => this.onExit(child, null, null, error));

    const ok = await this.waitHealthy(this.cfg.startTimeoutSec * 1000);
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    if (!ok) {
      this.setPhase('error', `service did not become healthy within ${this.cfg.startTimeoutSec}s`);
      await this.killChild();
      return;
    }
    const health = await this.health();
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    this.models = health?.models ?? this.models;
    this.backend = health?.backend ?? this.cfg.backend;
    this.onlineSince = this.deps.now();
    this.restarts = 0;
    this.setPhase('online', `${this.backend || this.cfg.backend} · ${this.models} models`);
    this.startMonitor();
  }

  private pipe(child: ChildLike): void {
    const write = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      this.sink?.write(text);
      this.opts.log.debug('audiocpp', { line: text.trim().slice(0, 400) });
    };
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
  }

  private onExit(child: ChildLike, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.childExited = true;
    if (this.stopping) return;
    const reason = error ? error.message : `exited (${code ?? signal ?? 'unknown'})`;
    this.setPhase('error', reason);
    this.sink?.close();
    this.sink = null;
    if (this.cfg.restartOnExit && this.cfg.autoStart && this.restarts < RESTART_DELAYS.length) {
      const delay = RESTART_DELAYS[this.restarts]!;
      this.restarts += 1;
      this.detail = `${reason}; restarting in ${Math.round(delay / 1000)}s (attempt ${this.restarts})`;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.start();
      }, delay);
      this.restartTimer.unref?.();
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.childExited = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (done) return; done = true; resolve(); };
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); return; }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
        finish();
      }, 5000);
      timer.unref?.();
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.now() < deadline) {
      if (this.childExited) return false;
      const health = await this.health();
      if (health) {
        this.models = health.models;
        this.backend = health.backend;
        return true;
      }
      await this.deps.sleep(500);
    }
    return false;
  }

  private async health(): Promise<{ models: number; backend: string } | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(`${this.baseUrl()}/health`, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as { status?: unknown; models?: unknown; backend?: unknown } | null;
      if (data?.status && data.status !== 'ok') return null;
      const models = typeof data?.models === 'number' ? data.models : Number(data?.models ?? 0) || 0;
      const backend = typeof data?.backend === 'string' ? data.backend : '';
      return { models, backend };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 探一次活,只改状态,不拉起进程。 */
  async refresh(): Promise<void> {
    if (this.stopping || this.phase === 'starting') return;
    const health = await this.health();
    if (this.stopping) return;
    if (health) {
      this.models = health.models;
      this.backend = health.backend;
      if (this.phase !== 'online') {
        this.onlineSince = this.deps.now();
        this.setPhase('online', `${health.backend} · ${health.models} models`);
      }
      if (this.onlineSince && this.deps.now() - this.onlineSince > 60_000) this.restarts = 0;
      return;
    }
    if (this.phase === 'online') this.setPhase('error', `health check failed at ${this.baseUrl()}`);
  }

  private startMonitor(): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => { void this.refresh(); }, Math.max(1000, this.cfg.pollMs));
    this.monitor.unref?.();
  }

  /** 开始周期探活;外部服务也适用。 */
  watch(): void {
    this.startMonitor();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.killChild();
    this.sink?.close();
    this.sink = null;
    this.models = 0;
    this.backend = '';
    this.setPhase('off', 'stopped');
  }

  private setPhase(phase: Phase, detail: string): void {
    if (this.phase === phase && this.detail === detail) return;
    this.phase = phase;
    this.detail = detail;
    this.deps.onPhase?.(this.status());
  }
}
