/**
 * 一个推理服务条目的进程管理:先探活,活着就接管;没活着按 type 预设拉起。
 * 探活、启动、退出、重启都只改这里的状态,World 只读状态和收回调。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import {
  endpointUrl, healthPathOf, healthUrl, hostPort, protocolOf, serverJsonPath,
} from './entry.ts';
import { apiUrl } from './protocol/http.ts';
import type { Phase, ServiceEntry, ServiceStatus, ServiceType } from './types.ts';

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
  onPhase?(status: ServiceStatus): void;
}

export interface SupervisorOptions {
  /** 被托管的服务条目。 */
  entry?: ServiceEntry;
  /** `entry` 的旧字段名,兼容直接迁移的调用方。 */
  cfg?: ServiceEntry;
  dataDir: string;
  log: Logger;
  deps?: Partial<SupervisorDeps>;
}

/** 重启退避:5 秒、15 秒、60 秒。 */
const RESTART_DELAYS = [5_000, 15_000, 60_000];
const HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_START_TIMEOUT_SEC = 60;
const DEFAULT_POLL_MS = 5000;
/** StartLux 预设默认连接的 llama-server 地址。 */
const DEFAULT_LLAMACPP_URL = 'http://127.0.0.1:8081';
const THINK_MODES = new Set(['auto', 'never', 'always']);
const HEALTHY_STATES = new Set(['ok', 'ready', 'healthy', 'up', 'online']);

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of raw.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter(Boolean);
}

function optionString(entry: ServiceEntry, key: string): string {
  const value = entry.options?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function optionNumber(entry: ServiceEntry, key: string, fallback: number): number {
  const value = entry.options?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionBoolean(entry: ServiceEntry, key: string, fallback: boolean): boolean {
  const value = entry.options?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 服务日志写在数据目录的 service-<id>.log。 */
export function serviceLogPath(entry: ServiceEntry, dataDir: string): string {
  const safe = entry.id.replace(/[^A-Za-z0-9._-]+/g, '_') || 'service';
  return join(dataDir, `service-${safe}.log`);
}

/** 未创建 Supervisor 的条目也有一份完整状态。 */
export function idleServiceStatus(entry: ServiceEntry): ServiceStatus {
  return {
    entry,
    phase: 'off',
    detail: entry.enabled ? 'not started' : 'disabled',
    external: false,
    managed: entry.manage,
    pid: null,
    models: 0,
    backend: '',
    baseUrl: endpointUrl(entry),
    restarts: 0,
  };
}

/** 有预设可执行名的类型;其余类型需要操作者给 binary。 */
function defaultBinary(type: ServiceType): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  switch (type) {
    case 'audiocpp': return `audiocpp_server${exe}`;
    case 'llamacpp': return `llama-server${exe}`;
    case 'systemone': return `startlux-decide${exe}`;
    default: return '';
  }
}

function defaultBackend(entry: ServiceEntry): string {
  if (entry.type === 'audiocpp') return optionString(entry, 'backend') || 'cuda';
  // StartLux 本地预设固定接 llama.cpp;只用于状态文案,健康接口给了 backend 时以它为准。
  if (entry.type === 'systemone' && entry.manage) return 'llamacpp';
  return '';
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function resolveCommand(entry: ServiceEntry): { command: string; checkExists: boolean } | { error: string } {
  const serverDir = entry.serverDir?.trim() ?? '';
  const raw = entry.binary?.trim() ?? '';
  const binary = raw || defaultBinary(entry.type);
  if (!binary) {
    return { error: `binary is required for type ${entry.type}` };
  }
  if (!raw && !serverDir) return { error: 'serverDir is empty' };
  const command = isAbsolute(binary) || !serverDir ? binary : join(serverDir, binary);
  return { command, checkExists: looksLikePath(command) };
}

function defaultDeps(): SupervisorDeps {
  return {
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init)) as typeof fetch,
    // command / args 已经是 argv;shell 恒为 false,面板其他字段不可能拼进命令行。
    launch: (spec) => spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
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
  private entry: ServiceEntry;
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
  private onlineSince: number | null = null;
  private restarts = 0;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: SupervisorOptions) {
    this.deps = { ...defaultDeps(), ...opts.deps };
    const entry = opts.entry ?? opts.cfg;
    if (!entry) throw new Error('SupervisorOptions.entry is required');
    this.entry = entry;
  }

  /** 配置是活数组;管理器替换条目对象时同步引用。 */
  setEntry(entry: ServiceEntry): void {
    this.entry = entry;
  }

  baseUrl(): string {
    return endpointUrl(this.entry);
  }

  status(): ServiceStatus {
    return {
      entry: this.entry,
      phase: this.phase,
      detail: this.detail,
      external: this.phase === 'online' && this.child === null,
      managed: this.entry.manage,
      pid: this.child?.pid ?? null,
      models: this.models,
      backend: this.backend,
      baseUrl: this.baseUrl(),
      restarts: this.restarts,
    };
  }

  /** 启动:先探活,已经活着就接管;否则按 type 预设拉起。不抛错,失败写进状态。 */
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
      this.backend = healthy.backend || defaultBackend(this.entry);
      this.onlineSince = this.deps.now();
      this.setPhase('online', `${this.backend || this.entry.type} · ${this.models} models`);
      this.startMonitor();
      return;
    }
    if (this.stopping) return;
    if (!this.entry.manage) {
      this.setPhase('error', `service is not reachable at ${this.baseUrl()}`);
      return;
    }
    if (this.entry.type === 'systemone' && !optionString(this.entry, 'modelDir')) {
      this.setPhase('off', 'options.modelDir is required for type systemone');
      return;
    }

    const resolved = resolveCommand(this.entry);
    if ('error' in resolved) {
      this.setPhase('off', resolved.error);
      return;
    }
    const command = resolved.command;
    if (resolved.checkExists && !this.deps.exists(command)) {
      this.setPhase('error', `executable not found: ${command}`);
      return;
    }

    const serverDir = this.entry.serverDir?.trim() ?? '';
    const cwd = serverDir || (isAbsolute(command) ? dirname(command) : process.cwd());
    const args = this.launchArgs();

    const logPath = serviceLogPath(this.entry, this.opts.dataDir);
    try {
      this.deps.mkdir(dirname(logPath));
      this.sink = this.deps.openLog(logPath);
      this.sink.write(`\n[${new Date(this.deps.now()).toISOString()}] ${command} ${args.join(' ')}\n`);
    } catch (error) {
      this.opts.log.warn(`服务 ${this.entry.id} 日志文件打不开`, { err: error instanceof Error ? error.message : String(error) });
      this.sink = null;
    }

    this.setPhase('starting', `launching ${command}`);
    this.childExited = false;
    let child: ChildLike;
    try {
      child = this.deps.launch({ command, args, cwd });
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

    // 没有 HTTP 协议(none)的条目无法探活:进程起来就算在线。
    if (healthPathOf(this.entry.type) === null) {
      this.onlineSince = this.deps.now();
      this.setPhase('online', `${this.entry.type} · process running`);
      this.startMonitor();
      return;
    }

    const startTimeoutSec = optionNumber(this.entry, 'startTimeoutSec', DEFAULT_START_TIMEOUT_SEC);
    const ok = await this.waitHealthy(startTimeoutSec * 1000);
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    if (!ok) {
      this.setPhase('error', `service did not become healthy within ${startTimeoutSec}s`);
      await this.killChild();
      return;
    }
    const health = await this.health();
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    this.models = health?.models ?? this.models;
    this.backend = health?.backend || defaultBackend(this.entry);
    // 计数只在稳定在线 60 秒后归零(refresh),否则 5s/15s/60s 退避会退化成无限 5s 重试。
    this.onlineSince = this.deps.now();
    this.setPhase('online', `${this.backend || this.entry.type} · ${this.models} models`);
    this.startMonitor();
  }

  /** audiocpp 与 systemone 有启动预设;其余类型只用条目自己的 args。 */
  private launchArgs(): string[] {
    if (this.entry.type === 'systemone') return this.systemoneArgs();
    if (this.entry.type !== 'audiocpp') return splitArgs(this.entry.args ?? '');

    const { host, port } = hostPort(this.entry);
    const args = [
      '--host', host,
      '--port', String(port),
      '--backend', optionString(this.entry, 'backend') || 'cuda',
    ];
    const device = optionNumber(this.entry, 'device', 0);
    if (device >= 0) args.push('--device', String(device));
    const threads = optionNumber(this.entry, 'threads', 0);
    if (threads > 0) args.push('--threads', String(threads));
    const idleUnloadMs = optionNumber(this.entry, 'idleUnloadMs', 0);
    if (idleUnloadMs > 0) args.push('--idle-unload-ms', String(idleUnloadMs));
    if (!optionBoolean(this.entry, 'ui', true)) args.push('--no-ui');
    args.push(...splitArgs(this.entry.args ?? ''));

    const configFile = serverJsonPath(this.entry);
    if (configFile && this.deps.exists(configFile)) args.unshift('--config', configFile);
    return args;
  }

  /**
   * StartLux 预设:startlux-decide serve 连另一条 llamacpp 条目拉起的 llama-server。
   * 参数顺序固定,便于测试与日志核对;条目 args 最后追加。
   */
  private systemoneArgs(): string[] {
    const modelDir = optionString(this.entry, 'modelDir');
    const llamacppUrl = optionString(this.entry, 'llamacppUrl') || DEFAULT_LLAMACPP_URL;
    const { host, port } = hostPort(this.entry);
    const args = [
      'serve',
      '--model', modelDir,
      '--backend', 'llamacpp',
      '--llamacpp-url', llamacppUrl,
      '--host', host,
      '--port', String(port),
    ];
    const thinkMode = optionString(this.entry, 'thinkMode');
    if (THINK_MODES.has(thinkMode)) args.push('--think-mode', thinkMode);
    const gate = this.entry.options?.gate;
    if (typeof gate === 'number' && Number.isFinite(gate)) args.push('--gate', String(gate));
    args.push(...splitArgs(this.entry.args ?? ''));
    return args;
  }

  private pipe(child: ChildLike): void {
    const write = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      this.sink?.write(text);
      this.opts.log.debug(this.entry.id, { line: text.trim().slice(0, 400) });
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
    this.onlineSince = null;
    this.setPhase('error', reason);
    this.sink?.close();
    this.sink = null;
    if (this.entry.restartOnExit && this.restarts < RESTART_DELAYS.length) {
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
        this.backend = health.backend || defaultBackend(this.entry);
        return true;
      }
      await this.deps.sleep(500);
    }
    return false;
  }

  private async probe(url: string): Promise<{
    status: number;
    health: { models: number; backend: string } | null;
  }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) return { status: res.status, health: null };
      const data = await res.json().catch(() => null) as {
        status?: unknown;
        models?: unknown;
        data?: unknown;
        backend?: unknown;
      } | null;
      if (!data) return { status: res.status, health: { models: 0, backend: '' } };
      if (typeof data.status === 'string' && !HEALTHY_STATES.has(data.status.toLowerCase())) {
        return { status: res.status, health: null };
      }
      const source = data.models ?? data.data;
      let models = 0;
      if (typeof source === 'number') models = source;
      else if (Array.isArray(source)) models = source.length;
      else if (source && typeof source === 'object') models = Object.keys(source).length;
      const backend = typeof data.backend === 'string' ? data.backend : '';
      return { status: res.status, health: { models, backend } };
    } catch {
      return { status: 0, health: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `/health` 是默认探活;openai / custom / systemone 的 `/health` 回 404 时,
   * 退回 OpenAI 形状的 `/v1/models`。
   */
  private async health(): Promise<{ models: number; backend: string } | null> {
    const url = healthUrl(this.entry);
    if (!url) return null;
    const first = await this.probe(url);
    if (first.health) return first.health;
    const protocol = protocolOf(this.entry);
    if (first.status === 404
      && (protocol === 'openai' || protocol === 'custom' || protocol === 'systemone')) {
      const fallback = await this.probe(apiUrl(endpointUrl(this.entry), '/models'));
      return fallback.health;
    }
    return null;
  }

  /** 探一次活,只改状态,不拉起进程。 */
  async refresh(): Promise<void> {
    if (this.stopping || this.phase === 'starting') return;
    if (healthPathOf(this.entry.type) === null) return;
    const health = await this.health();
    if (this.stopping) return;
    if (health) {
      this.models = health.models;
      this.backend = health.backend || defaultBackend(this.entry);
      if (this.phase !== 'online') {
        this.onlineSince = this.deps.now();
        this.setPhase('online', `${this.backend || this.entry.type} · ${health.models} models`);
      }
      if (this.onlineSince !== null && this.deps.now() - this.onlineSince > 60_000) this.restarts = 0;
      return;
    }
    if (this.phase === 'online') this.setPhase('error', `health check failed at ${this.baseUrl()}`);
  }

  private startMonitor(): void {
    if (this.monitor) return;
    const pollMs = optionNumber(this.entry, 'pollMs', DEFAULT_POLL_MS);
    this.monitor = setInterval(() => { void this.refresh(); }, Math.max(1000, pollMs));
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
    this.onlineSince = null;
    this.setPhase('off', 'stopped');
  }

  private setPhase(phase: Phase, detail: string): void {
    if (this.phase === phase && this.detail === detail) return;
    this.phase = phase;
    this.detail = detail;
    this.deps.onPhase?.(this.status());
  }
}
