/**
 * 一个推理服务条目的进程管理:先探活,活着就接管;没活着按 type 预设拉起。
 * 探活、启动、退出、重启都只改这里的状态,World 只读状态和收回调。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import {
  endpointUrl, healthPathOf, healthUrl, hostPort, llamacppLaunchMode, protocolOf, serverJsonPath,
  tasksOfEntry,
} from './entry.ts';
import { apiUrl } from './protocol/http.ts';
import type { Phase, ServiceEntry, ServiceStatus } from './types.ts';

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
  /** 追加到父进程环境；StartLux Decision 用它设置 STARTLUX_LLAMACPP_BIDIR。 */
  env?: Record<string, string>;
}

export interface LogSink {
  write(chunk: string): void;
  close(): void;
}

/** 参数里是否已有 --name 或 --name=value。 */
function hasArg(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** 同上，但接受一组同义参数（如 -c / --ctx-size）。 */
function ensureAnyArg(args: string[], names: readonly string[], value: string): void {
  if (!names.some((name) => hasArg(args, name))) args.push(names[0]!, value);
}

/** 一组同义参数里是否已有任意一个。 */
function hasAnyArg(args: readonly string[], names: readonly string[]): boolean {
  return names.some((name) => hasArg(args, name));
}

/** 移除 name 及其值（同时处理 name=value）。 */
function stripArg(args: string[], name: string): void {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!;
    if (arg === name) args.splice(index, 2);
    else if (arg.startsWith(`${name}=`)) args.splice(index, 1);
  }
}

/** 强制成 name value；已有 name 或 name=value 时先移除。 */
function setArg(args: string[], name: string, value: string): void {
  stripArg(args, name);
  args.push(name, value);
}

/** 一组同义参数强制成第一个名字；其余同义写法一并移除。 */
function setAnyArg(args: string[], names: readonly string[], value: string): void {
  for (const name of names) stripArg(args, name);
  args.push(names[0]!, value);
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
  /** 同一组配置里的其他条目;StartLux Decision 用它把服务 id 解析成 llama.cpp 地址。 */
  peers?(): readonly ServiceEntry[];
  deps?: Partial<SupervisorDeps>;
}

/** 重启退避:5 秒、15 秒、60 秒。 */
const RESTART_DELAYS = [5_000, 15_000, 60_000];
const HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_START_TIMEOUT_SEC = 60;
const DEFAULT_POLL_MS = 5000;
const THINK_MODES = new Set(['auto', 'never', 'always']);
/** StartLux Instant 的 GGUF 带非因果注意力标记；stock llama-server 用 server 模式整段读 prompt。 */
const DEFAULT_BIDIR_MODE = 'server';
const HEALTHY_STATES = new Set(['ok', 'ready', 'healthy', 'up', 'online']);
const LLAMACPP_MODEL_ARGS = ['-m', '--model'] as const;
const LLAMACPP_TASK_ARGS = {
  embeddings: ['--embeddings', '--embedding'],
  rerank: ['--reranking', '--rerank'],
} as const;

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
    tasks: tasksOfEntry(entry),
    models: 0,
    backend: '',
    baseUrl: endpointUrl(entry),
    restarts: 0,
  };
}

/** 有预设可执行名的类型;其余类型需要操作者给 binary。 */
function defaultBinary(entry: ServiceEntry): string {
  const exe = process.platform === 'win32' ? '.exe' : '';
  switch (entry.type) {
    case 'audiocpp': return `audiocpp_server${exe}`;
    case 'llamacpp':
      // ggml-org 的 llama-server 没有 serve 子命令。
      return `llama-server${exe}`;
    case 'startlux':
      // 直接运行 venv 里的入口即可，不需要先 activate。
      return process.platform === 'win32'
        ? '.venv/Scripts/startlux-decide.exe'
        : '.venv/bin/startlux-decide';
    default: return '';
  }
}

function defaultBackend(entry: ServiceEntry): string {
  if (entry.type === 'audiocpp') return optionString(entry, 'backend') || 'cuda';
  return '';
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function resolveCommand(
  entry: ServiceEntry,
  exists: (path: string) => boolean,
): { command: string; checkExists: boolean } | { error: string } {
  const serverDir = entry.serverDir?.trim() ?? '';
  const binary = entry.binary?.trim() || defaultBinary(entry);
  if (!binary) {
    return { error: `binary is required for type ${entry.type}` };
  }
  if (!entry.binary?.trim() && !serverDir) return { error: 'serverDir is empty' };
  const command = isAbsolute(binary) || !serverDir ? binary : join(serverDir, binary);
  return { command, checkExists: looksLikePath(command) };
}

/** StartLux Decision 的 `--llamacpp-url` 要的是 llama-server 的 origin，不带路径。 */
function llamacppOrigin(entry: Pick<ServiceEntry, 'type' | 'endpoint'>): string {
  return new URL(endpointUrl(entry)).origin;
}

/** StartLux Decision 的 `--llamacpp-url`：优先按条目 id 取地址，其次用显式 URL。 */
function resolveLlamacppUrl(
  entry: ServiceEntry,
  peers: readonly ServiceEntry[],
): { url: string } | { error: string } {
  const serviceId = optionString(entry, 'llamacppService');
  if (serviceId) {
    const peer = peers.find((item) => item.id === serviceId);
    if (!peer) return { error: `llama.cpp service not found: ${serviceId}` };
    if (peer.type !== 'llamacpp') return { error: `${serviceId} is not a llama.cpp service` };
    return { url: llamacppOrigin(peer) };
  }
  const configured = optionString(entry, 'llamacppUrl');
  if (configured) return { url: llamacppOrigin({ type: 'llamacpp', endpoint: configured }) };
  return { error: 'options.llamacppService or options.llamacppUrl is required for a managed StartLux Decision' };
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
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
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
      tasks: tasksOfEntry(this.entry),
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
    const migration = this.migrationMessage();
    if (migration) {
      this.setPhase('off', migration);
      return;
    }

    const health = await this.health();
    if (this.stopping) return;
    if (health) {
      this.models = health.models;
      this.backend = health.backend || defaultBackend(this.entry);
      this.onlineSince = this.deps.now();
      this.setPhase('online', this.onlineDetail());
      this.startMonitor();
      return;
    }
    if (!this.entry.manage) {
      this.setPhase('error', `service is not reachable at ${this.baseUrl()}`);
      return;
    }

    const plan = this.launchSpec();
    if ('error' in plan) {
      this.setPhase('off', plan.error);
      return;
    }
    if (plan.checkExists && !this.deps.exists(plan.spec.command)) {
      this.setPhase('error', `executable not found: ${plan.spec.command}`);
      return;
    }

    const logPath = serviceLogPath(this.entry, this.opts.dataDir);
    try {
      this.deps.mkdir(dirname(logPath));
      this.sink = this.deps.openLog(logPath);
    } catch (error) {
      this.opts.log.warn(`服务 ${this.entry.id} 日志文件打不开`, { err: error instanceof Error ? error.message : String(error) });
      this.sink = null;
    }

    this.setPhase('starting', `launching ${plan.spec.command}`);
    this.childExited = false;
    let child: ChildLike;
    try {
      child = this.deps.launch(plan.spec);
    } catch (error) {
      this.setPhase('error', `launch failed: ${error instanceof Error ? error.message : String(error)}`);
      this.sink?.close();
      this.sink = null;
      return;
    }
    this.child = child;
    this.sink?.write(`\n[${new Date(this.deps.now()).toISOString()}] ${plan.spec.command} ${plan.spec.args.join(' ')}\n`);
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
      this.sink?.close();
      this.sink = null;
      return;
    }
    const finalHealth = await this.health();
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    if (!finalHealth) {
      this.setPhase('error', `service did not become healthy within ${startTimeoutSec}s`);
      await this.killChild();
      this.sink?.close();
      this.sink = null;
      return;
    }
    this.models = finalHealth.models;
    this.backend = finalHealth.backend || defaultBackend(this.entry);
    // 计数只在稳定在线 60 秒后归零(refresh),否则 5s/15s/60s 退避会退化成无限 5s 重试。
    this.onlineSince = this.deps.now();
    this.setPhase('online', this.onlineDetail());
    this.startMonitor();
  }

  private onlineDetail(): string {
    return `${this.backend || this.entry.type} · ${this.models} models`;
  }

  /** 0.8 及更早的本地 StartLux 配置不再由 llamacpp / systemone 托管。 */
  private migrationMessage(): string | null {
    if (this.entry.type === 'llamacpp' && tasksOfEntry(this.entry).includes('systemone')) {
      return 'llama.cpp no longer hosts systemone; add a StartLux Decision service';
    }
    if (this.entry.type === 'llamacpp') {
      const rawArgs = this.entry.args ?? '';
      const legacyServe = this.entry.options?.launchMode === 'serve'
        || /(^|\s)serve(\s|$)/.test(rawArgs);
      if (legacyServe) {
        const binary = (this.entry.binary?.trim() ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
        if (/^llama(\.exe)?$/.test(binary)) {
          return 'llama serve was removed; use llama-server or change the launch mode';
        }
        const hasModel = /(^|\s)(-m|--model)(\s|=)/.test(rawArgs);
        const hasDir = Boolean(optionString(this.entry, 'modelsDir'))
          || /(^|\s)--models-dir(\s|=)/.test(rawArgs);
        if (!hasModel && !hasDir) {
          return 'legacy llama serve config has no model; set options.modelsDir or add -m to args';
        }
      }
    }
    if (this.entry.type === 'systemone' && optionString(this.entry, 'modelDir')
      && !this.entry.binary?.trim()) {
      return 'local StartLux moved to the StartLux Decision type';
    }
    return null;
  }

  /** 按类型组启动参数,并做拉起前校验;失败只返回文本。 */
  private launchSpec(): { spec: LaunchSpec; checkExists: boolean } | { error: string } {
    if (this.entry.type === 'startlux' && !optionString(this.entry, 'modelDir')) {
      return { error: 'options.modelDir is required for a StartLux Decision service' };
    }
    if (this.entry.type === 'startlux') {
      const upstream = resolveLlamacppUrl(this.entry, this.opts.peers?.() ?? []);
      if ('error' in upstream) return { error: upstream.error };
    }
    if (this.entry.type === 'llamacpp' && llamacppLaunchMode(this.entry) === 'single') {
      const args = splitArgs(this.entry.args ?? '');
      if (!hasAnyArg(args, LLAMACPP_MODEL_ARGS) && !this.llamacppModelPath()) {
        return { error: 'single-model llama.cpp needs options.modelsDir + one model, or -m in args' };
      }
    }
    if (this.entry.type === 'llamacpp' && llamacppLaunchMode(this.entry) === 'router'
      && !optionString(this.entry, 'modelsDir')
      && !hasArg(splitArgs(this.entry.args ?? ''), '--models-dir')) {
      return { error: 'multi-model llama.cpp needs options.modelsDir or --models-dir in args' };
    }

    const resolved = resolveCommand(this.entry, (path) => this.deps.exists(path));
    if ('error' in resolved) return { error: resolved.error };
    const serverDir = this.entry.serverDir?.trim() ?? '';
    const env: Record<string, string> = {};
    if (this.entry.type === 'llamacpp') {
      // llama.app 和 llama.cpp 都用 LLAMA_CACHE 找已下载的模型；不下载，只复用。
      const cacheDir = optionString(this.entry, 'cacheDir');
      if (cacheDir) env.LLAMA_CACHE = cacheDir;
    }
    if (this.entry.type === 'startlux') {
      env.STARTLUX_LLAMACPP_BIDIR = optionString(this.entry, 'bidirMode') || DEFAULT_BIDIR_MODE;
    }
    return {
      checkExists: resolved.checkExists,
      spec: {
        command: resolved.command,
        args: this.launchArgs(),
        cwd: serverDir || (isAbsolute(resolved.command) ? dirname(resolved.command) : process.cwd()),
        ...(Object.keys(env).length ? { env } : {}),
      },
    };
  }

  /** audiocpp / llamacpp / startlux 有启动预设;其余类型只用条目自己的 args。 */
  private launchArgs(): string[] {
    if (this.entry.type === 'llamacpp') return this.llamacppArgs();
    if (this.entry.type === 'startlux') return this.startluxArgs();
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

  /** 单模型条目选中的 GGUF 文件；名字是 modelsDir 下的相对路径（不带扩展名）。 */
  private llamacppModelPath(): string | null {
    const name = (this.entry.models ?? []).map((model) => model.trim()).find(Boolean);
    if (!name) return null;
    if (isAbsolute(name)) return name;
    const modelsDir = optionString(this.entry, 'modelsDir');
    if (!modelsDir) return null;
    const hasExt = /\.gguf$/i.test(name);
    const candidates = hasExt ? [name] : [`${name}.gguf`, name, `${name}.GGUF`];
    for (const candidate of candidates) {
      const path = join(modelsDir, candidate);
      if (this.deps.exists(path)) return path;
    }
    return join(modelsDir, hasExt ? name : `${name}.gguf`);
  }

  /**
   * llama.cpp 条目：多模型用 `--models-dir`，单模型用 `-m`。操作者显式给的值优先，
   * 但受管参数会按条目配置强制成一致的值。
   */
  private llamacppArgs(): string[] {
    const args = splitArgs(this.entry.args ?? '');
    if (args[0] === 'serve') args.shift();
    const mode = llamacppLaunchMode(this.entry);
    const { host, port } = hostPort(this.entry);
    setArg(args, '--host', host);
    setArg(args, '--port', String(port));

    if (mode === 'router') {
      const modelsDir = optionString(this.entry, 'modelsDir');
      if (modelsDir) setArg(args, '--models-dir', modelsDir);
      // 多模型只看目录；残余的 -m 会和 --models-dir 打架。
      for (const name of LLAMACPP_MODEL_ARGS) stripArg(args, name);
    } else {
      stripArg(args, '--models-dir');
      if (!hasAnyArg(args, LLAMACPP_MODEL_ARGS)) {
        const modelPath = this.llamacppModelPath();
        if (modelPath) setAnyArg(args, LLAMACPP_MODEL_ARGS, modelPath);
      }
    }

    const contextSize = optionNumber(this.entry, 'contextSize', -1);
    if (contextSize >= 0) setAnyArg(args, ['-c', '--ctx-size'], String(contextSize));
    const nGpuLayers = optionString(this.entry, 'nGpuLayers');
    if (nGpuLayers) setAnyArg(args, ['-ngl', '--gpu-layers', '--n-gpu-layers'], nGpuLayers);
    const parallel = optionNumber(this.entry, 'parallel', 0);
    if (parallel > 0) setAnyArg(args, ['--parallel', '-np'], String(parallel));
    this.addLlamacppTaskFlags(args);
    return args;
  }

  /** 按 tasks 打开 llama.cpp 的 embeddings / rerank 端点；chat 不加旗标。 */
  private addLlamacppTaskFlags(args: string[]): void {
    const tasks = tasksOfEntry(this.entry);
    for (const task of ['embeddings', 'rerank'] as const) {
      if (!tasks.includes(task)) continue;
      const names = LLAMACPP_TASK_ARGS[task];
      if (!hasAnyArg(args, names)) args.push(names[0]);
    }
  }

  /** StartLux Decision：把 typed systemone 请求代理到一条 llama.cpp 条目的 GGUF 上。 */
  private startluxArgs(): string[] {
    const modelDir = optionString(this.entry, 'modelDir');
    const { host, port } = hostPort(this.entry);
    const upstream = resolveLlamacppUrl(this.entry, this.opts.peers?.() ?? []);
    const url = 'url' in upstream ? upstream.url : '';
    const args = [
      'serve',
      '--model', modelDir,
      '--backend', 'llamacpp',
      '--llamacpp-url', url,
      '--host', host,
      '--port', String(port),
    ];
    const thinkMode = optionString(this.entry, 'thinkMode');
    const instant = optionBoolean(this.entry, 'instant', false);
    if (THINK_MODES.has(thinkMode) && !(instant && thinkMode !== 'never')) {
      args.push('--think-mode', thinkMode);
    } else if (instant && THINK_MODES.has(thinkMode)) {
      this.opts.log.warn('StartLux Instant 模型不接受自动思考，已忽略 --think-mode', {
        id: this.entry.id, thinkMode,
      });
    }
    const gate = this.entry.options?.gate;
    if (typeof gate === 'number' && Number.isFinite(gate)) args.push('--gate', String(gate));

    const extra = splitArgs(this.entry.args ?? '');
    if (extra[0] === 'serve') extra.shift();
    for (const managed of ['--model', '--backend', '--llamacpp-url', '--host', '--port',
      '--think-mode', '--gate']) {
      stripArg(extra, managed);
    }
    if (instant) stripArg(extra, '--think-mode');
    args.push(...extra);
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
    if (child !== this.child) return;
    this.child = null;
    this.childExited = true;
    if (this.stopping) return;
    const reason = error ? error.message : `exited (${code ?? signal ?? 'unknown'})`;
    this.onlineSince = null;
    this.setPhase('error', reason);
    this.sink?.close();
    this.sink = null;
    if (this.restartTimer) return;
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
    this.child = null;
    this.childExited = true;
    if (!child) return;
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
      if (this.stopping || this.childExited) return false;
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
        model?: unknown;
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
      // startlux-decide 的 /health 只报一个 model 名。
      if (models === 0 && typeof data.model === 'string' && data.model.trim()) models = 1;
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
   * 退回 OpenAI 形状的 `/v1/models`。StartLux Decision 走 systemone 方言。
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
    const migration = this.migrationMessage();
    if (migration) {
      this.setPhase('off', migration);
      return;
    }
    if (healthPathOf(this.entry.type) === null) return;
    const health = await this.health();
    if (this.stopping) return;
    if (health) {
      this.models = health.models;
      this.backend = health.backend || defaultBackend(this.entry);
      if (this.phase !== 'online') {
        this.onlineSince = this.deps.now();
        this.setPhase('online', this.onlineDetail());
      }
      if (this.onlineSince !== null && this.deps.now() - this.onlineSince > 60_000) this.restarts = 0;
      return;
    }
    if (this.phase === 'online') {
      this.setPhase('error', `health check failed at ${this.baseUrl()}`);
    }
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
