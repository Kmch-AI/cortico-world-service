/**
 * 一个推理服务条目的进程管理:先探活,活着就接管;没活着按 type 预设拉起。
 * 探活、启动、退出、重启都只改这里的状态,World 只读状态和收回调。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import {
  endpointUrl, healthPathOf, healthUrl, hostPort, isStartLuxEntry, llamacppLaunchMode,
  protocolOf, primaryOrigin, serverJsonPath, systemoneEndpointOf, systemoneHostPort, tasksOfEntry,
  type LlamacppLaunchMode,
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
  /** 追加到父进程环境；StartLux 用它设置 STARTLUX_LLAMACPP_BIDIR。 */
  env?: Record<string, string>;
}

export interface LogSink {
  write(chunk: string): void;
  close(): void;
}

type ProcessRole = 'primary' | 'companion';

interface LaunchPlan {
  role: ProcessRole;
  spec: LaunchSpec;
}

/** 参数里是否已有 --name 或 --name=value。 */
function hasArg(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** 没有时追加 name value；已有则保留操作者的值。 */
function ensureArg(args: string[], name: string, value: string): void {
  if (!hasArg(args, name)) args.push(name, value);
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
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!;
    if (arg === name) {
      args.splice(index, 2);
    } else if (arg.startsWith(`${name}=`)) {
      args.splice(index, 1);
    }
  }
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
    companionPid: null,
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
      // llama.app 的二进制是 llama，ggml-org 的 llama-server 没有 serve 子命令。
      return llamacppLaunchMode(entry) === 'serve' ? `llama${exe}` : `llama-server${exe}`;
    default: return '';
  }
}

function defaultBackend(entry: ServiceEntry): string {
  if (entry.type === 'audiocpp') return optionString(entry, 'backend') || 'cuda';
  // StartLux 托管在 llama.cpp 条目下;只用于状态文案,健康接口给了 backend 时以它为准。
  if (isStartLuxEntry(entry)) return 'llamacpp';
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
  const raw = entry.binary?.trim() ?? '';
  let binary = raw || defaultBinary(entry);
  if (!binary) {
    return { error: `binary is required for type ${entry.type}` };
  }
  if (!raw && !serverDir) return { error: 'serverDir is empty' };
  // llama.app 的二进制叫 llama；有些 Windows 构建沿用 llama-server。serve 模式两个都找。
  if (!raw && entry.type === 'llamacpp' && llamacppLaunchMode(entry) === 'serve') {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const fallback = `llama-server${exe}`;
    if (!exists(join(serverDir, binary)) && exists(join(serverDir, fallback))) binary = fallback;
  }
  const command = isAbsolute(binary) || !serverDir ? binary : join(serverDir, binary);
  return { command, checkExists: looksLikePath(command) };
}

/** StartLux 伴生进程:默认 startlux-decide，目录来自 options.startluxDir。 */
function resolveCompanionCommand(
  entry: ServiceEntry,
): { command: string; cwd: string; checkExists: boolean } | { error: string } {
  const dir = optionString(entry, 'startluxDir');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const raw = optionString(entry, 'startluxBinary') || `startlux-decide${exe}`;
  if (!isAbsolute(raw) && !dir) {
    return { error: 'options.startluxDir is required for a managed StartLux companion' };
  }
  const command = isAbsolute(raw) || !dir ? raw : join(dir, raw);
  const cwd = dir || (isAbsolute(command) ? dirname(command) : process.cwd());
  return { command, cwd, checkExists: looksLikePath(command) };
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
  /** 主进程:llama-server / audiocpp 等。 */
  private child: ChildLike | null = null;
  /** 伴生进程:llama.cpp 条目托管 StartLux 时的 startlux-decide。 */
  private companionChild: ChildLike | null = null;
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
      external: this.phase === 'online' && this.child === null && this.companionChild === null,
      managed: this.entry.manage,
      pid: this.child?.pid ?? this.companionChild?.pid ?? null,
      companionPid: this.companionChild?.pid ?? null,
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
    const withCompanion = isStartLuxEntry(this.entry);
    const primaryHealth = await this.health();
    if (this.stopping) return;
    const companionHealth = withCompanion ? await this.companionHealth() : null;
    if (this.stopping) return;
    const primaryReady = primaryHealth !== null;
    const companionReady = !withCompanion || companionHealth !== null;
    if (primaryReady && companionReady) {
      this.models = primaryHealth.models;
      this.backend = primaryHealth.backend || defaultBackend(this.entry);
      this.onlineSince = this.deps.now();
      this.setPhase('online', this.onlineDetail());
      this.startMonitor();
      return;
    }
    if (!this.entry.manage) {
      const where = !primaryReady ? this.baseUrl() : systemoneEndpointOf(this.entry);
      this.setPhase('error', `service is not reachable at ${where}`);
      return;
    }
    if (this.entry.type === 'systemone' && optionString(this.entry, 'modelDir')
      && !this.entry.binary?.trim()) {
      this.setPhase('off', 'local StartLux moved to type llamacpp with tasks ["systemone"]');
      return;
    }

    let primaryPlan: LaunchPlan | null = null;
    if (!primaryReady) {
      const resolved = resolveCommand(this.entry, (path) => this.deps.exists(path));
      if ('error' in resolved) {
        this.setPhase('off', resolved.error);
        return;
      }
      if (resolved.checkExists && !this.deps.exists(resolved.command)) {
        this.setPhase('error', `executable not found: ${resolved.command}`);
        return;
      }
      const serverDir = this.entry.serverDir?.trim() ?? '';
      const env: Record<string, string> = {};
      if (this.entry.type === 'llamacpp') {
        // llama.app 和 llama.cpp 都用 LLAMA_CACHE 找已下载的模型；不下载，只复用。
        const cacheDir = optionString(this.entry, 'cacheDir');
        if (cacheDir) env.LLAMA_CACHE = cacheDir;
      }
      primaryPlan = {
        role: 'primary',
        spec: {
          command: resolved.command,
          args: this.launchArgs(),
          cwd: serverDir || (isAbsolute(resolved.command) ? dirname(resolved.command) : process.cwd()),
          ...(Object.keys(env).length ? { env } : {}),
        },
      };
    }

    let companionPlan: LaunchPlan | null = null;
    if (withCompanion && !companionReady) {
      if (!optionString(this.entry, 'modelDir')) {
        this.setPhase('off', 'options.modelDir is required for a StartLux (systemone) model');
        return;
      }
      const resolved = resolveCompanionCommand(this.entry);
      if ('error' in resolved) {
        this.setPhase('off', resolved.error);
        return;
      }
      if (resolved.checkExists && !this.deps.exists(resolved.command)) {
        this.setPhase('error', `executable not found: ${resolved.command}`);
        return;
      }
      let args: string[];
      try {
        systemoneHostPort(this.entry);
        args = this.companionArgs();
      } catch (error) {
        this.setPhase('off', `invalid StartLux endpoint: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      companionPlan = {
        role: 'companion',
        spec: {
          command: resolved.command,
          args,
          cwd: resolved.cwd,
          env: {
            STARTLUX_LLAMACPP_BIDIR: optionString(this.entry, 'bidirMode') || DEFAULT_BIDIR_MODE,
          },
        },
      };
    }

    const logPath = serviceLogPath(this.entry, this.opts.dataDir);
    try {
      this.deps.mkdir(dirname(logPath));
      this.sink = this.deps.openLog(logPath);
    } catch (error) {
      this.opts.log.warn(`服务 ${this.entry.id} 日志文件打不开`, { err: error instanceof Error ? error.message : String(error) });
      this.sink = null;
    }

    const plans = [primaryPlan, companionPlan].filter((plan): plan is LaunchPlan => plan !== null);
    this.setPhase('starting', `launching ${plans.map((plan) => plan.spec.command).join(', ')}`);
    this.childExited = false;

    // 先让 llama-server 健康，再起 startlux-decide；后者启动时会连它。
    if (primaryPlan) {
      const failure = this.launchPlan(primaryPlan);
      if (failure) {
        this.setPhase('error', failure);
        await this.killChild();
        this.sink?.close();
        this.sink = null;
        return;
      }
      const startTimeoutSec = optionNumber(this.entry, 'startTimeoutSec', DEFAULT_START_TIMEOUT_SEC);
      const primaryOk = await this.waitHealthy(startTimeoutSec * 1000, false);
      if (this.stopping || this.childExited) {
        await this.killChild();
        return;
      }
      if (!primaryOk) {
        this.setPhase('error', `service did not become healthy within ${startTimeoutSec}s`);
        await this.killChild();
        this.sink?.close();
        this.sink = null;
        return;
      }
    }
    if (companionPlan) {
      const failure = this.launchPlan(companionPlan);
      if (failure) {
        this.setPhase('error', failure);
        await this.killChild();
        this.sink?.close();
        this.sink = null;
        return;
      }
    }

    // 没有 HTTP 协议(none)的条目无法探活:进程起来就算在线。
    if (healthPathOf(this.entry.type) === null && !withCompanion) {
      this.onlineSince = this.deps.now();
      this.setPhase('online', `${this.entry.type} · process running`);
      this.startMonitor();
      return;
    }

    const startTimeoutSec = optionNumber(this.entry, 'startTimeoutSec', DEFAULT_START_TIMEOUT_SEC);
    const ok = await this.waitHealthy(startTimeoutSec * 1000, withCompanion);
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
    const health = await this.health();
    const companion = withCompanion ? await this.companionHealth() : null;
    if (this.stopping || this.childExited) {
      await this.killChild();
      return;
    }
    if (!health || (withCompanion && !companion)) {
      this.setPhase('error', `service did not become healthy within ${startTimeoutSec}s`);
      await this.killChild();
      this.sink?.close();
      this.sink = null;
      return;
    }
    this.models = health.models;
    this.backend = health.backend || defaultBackend(this.entry);
    // 计数只在稳定在线 60 秒后归零(refresh),否则 5s/15s/60s 退避会退化成无限 5s 重试。
    this.onlineSince = this.deps.now();
    this.setPhase('online', this.onlineDetail());
    this.startMonitor();
  }

  private onlineDetail(): string {
    const base = `${this.backend || this.entry.type} · ${this.models} models`;
    return isStartLuxEntry(this.entry) ? `${base} + StartLux` : base;
  }

  /** 拉起一个进程并把退出回调接到同一组状态；失败只返回文本，不抛错。 */
  private launchPlan(plan: LaunchPlan): string | null {
    let child: ChildLike;
    try {
      child = this.deps.launch(plan.spec);
    } catch (error) {
      return `launch failed (${plan.role}): ${error instanceof Error ? error.message : String(error)}`;
    }
    if (plan.role === 'primary') this.child = child;
    else this.companionChild = child;
    this.sink?.write(`\n[${new Date(this.deps.now()).toISOString()}] [${plan.role}] ${plan.spec.command} ${plan.spec.args.join(' ')}\n`);
    this.pipe(child, plan.role);
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.once('error', (error) => this.onExit(child, null, null, error));
    return null;
  }

  /** audiocpp / llamacpp 有启动预设;其余类型只用条目自己的 args。 */
  private launchArgs(): string[] {
    if (this.entry.type === 'llamacpp') return this.llamacppArgs();
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
   * llama.cpp 条目：StartLux 固定单模型并补 Instant 参数；普通模型按 serve / router / single
   * 三种方式补 host、port、模型目录与任务开关。操作者显式给的值优先。
   */
  private llamacppArgs(): string[] {
    const args = splitArgs(this.entry.args ?? '');
    const { host, port } = hostPort(this.entry);
    if (isStartLuxEntry(this.entry)) {
      // StartLux 的思考参数属于伴生进程，llama-server 不认识。
      stripArg(args, '--think-mode');
      stripArg(args, '--gate');
      // 条目 endpoint 是探活与路由的唯一地址；args 里的 host/port 不能和它打架。
      setArg(args, '--host', host);
      setArg(args, '--port', String(port));
      // Instant 的 prompt 必须整段、单 slot 评估;这两项不能让操作者用默认值覆盖。
      setAnyArg(args, ['--parallel', '-np'], '1');
      setArg(args, '--ctx-checkpoints', '0');
      ensureAnyArg(args, ['-b', '--batch-size'], '16384');
      ensureAnyArg(args, ['-ub', '--ubatch-size'], '16384');
      ensureAnyArg(args, ['-c', '--ctx-size'], '20480');
      return args;
    }

    const mode = llamacppLaunchMode(this.entry);
    setArg(args, '--host', host);
    setArg(args, '--port', String(port));

    if (mode === 'serve') {
      if (args[0] !== 'serve') args.unshift('serve');
    } else if (args[0] === 'serve') {
      // 从 serve 切到 router/single 时清掉残留子命令。
      args.shift();
    }

    if (mode !== 'single') {
      const modelsDir = optionString(this.entry, 'modelsDir');
      if (modelsDir) setArg(args, '--models-dir', modelsDir);
    }
    const contextSize = optionNumber(this.entry, 'contextSize', -1);
    if (contextSize >= 0) setAnyArg(args, ['-c', '--ctx-size'], String(contextSize));
    const nGpuLayers = optionString(this.entry, 'nGpuLayers');
    if (nGpuLayers) setAnyArg(args, ['-ngl', '--gpu-layers', '--n-gpu-layers'], nGpuLayers);
    const parallel = optionNumber(this.entry, 'parallel', 0);
    if (parallel > 0) setAnyArg(args, ['--parallel', '-np'], String(parallel));
    this.addLlamacppTaskFlags(args, mode);
    return args;
  }

  /** 按 tasks 打开 llama.cpp 的 embeddings / rerank 端点；两种 CLI 的旗标不同。 */
  private addLlamacppTaskFlags(args: string[], mode: LlamacppLaunchMode): void {
    const tasks = tasksOfEntry(this.entry);
    if (tasks.includes('embeddings')) {
      const names = mode === 'serve'
        ? ['--embedding', '--embeddings']
        : ['--embeddings', '--embedding'];
      if (!hasAnyArg(args, names)) args.push(names[0]!);
    }
    if (tasks.includes('rerank')) {
      const names = mode === 'serve'
        ? ['--rerank', '--reranking']
        : ['--reranking', '--rerank'];
      if (!hasAnyArg(args, names)) args.push(names[0]!);
    }
  }

  /** 伴生 startlux-decide:把 typed systemone 请求翻译成 llama-server 的 prompt/readout。 */
  private companionArgs(): string[] {
    const modelDir = optionString(this.entry, 'modelDir');
    const { host, port } = systemoneHostPort(this.entry);
    const args = [
      'serve',
      '--model', modelDir,
      '--backend', 'llamacpp',
      '--llamacpp-url', primaryOrigin(this.entry),
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
    const extra = splitArgs(optionString(this.entry, 'startluxArgs'));
    for (const managed of ['--model', '--backend', '--llamacpp-url', '--host', '--port',
      '--think-mode', '--gate']) {
      stripArg(extra, managed);
    }
    if (instant) stripArg(extra, '--think-mode');
    args.push(...extra);
    return args;
  }

  private pipe(child: ChildLike, role: ProcessRole): void {
    const write = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      this.sink?.write(`[${role}] ${text}`);
      this.opts.log.debug(this.entry.id, { line: text.trim().slice(0, 400) });
    };
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
  }

  private onExit(child: ChildLike, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    const role: ProcessRole | null = child === this.child
      ? 'primary'
      : child === this.companionChild ? 'companion' : null;
    if (!role) return;
    if (role === 'primary') this.child = null;
    else this.companionChild = null;
    this.childExited = true;
    if (this.stopping) return;
    const reason = error
      ? `${role} ${error.message}`
      : `${role} exited (${code ?? signal ?? 'unknown'})`;
    this.onlineSince = null;
    this.setPhase('error', reason);
    if (role === 'primary') {
      // 主进程退出：自己拉起的伴生也收掉，整组重启。
      void this.killChild();
      this.sink?.close();
      this.sink = null;
    }
    // 伴生退出：保留已经加载好的 llama-server，只重启伴生。
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

  private async killOne(child: ChildLike | null): Promise<void> {
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

  private async killChild(): Promise<void> {
    const primary = this.child;
    const companion = this.companionChild;
    this.child = null;
    this.companionChild = null;
    this.childExited = true;
    // 先停伴生，避免它在 llama-server 退出后继续报错。
    await this.killOne(companion);
    await this.killOne(primary);
  }

  private async waitHealthy(timeoutMs: number, withCompanion: boolean): Promise<boolean> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.now() < deadline) {
      if (this.stopping || this.childExited) return false;
      const health = await this.health();
      const companion = withCompanion ? await this.companionHealth() : null;
      if (health && (!withCompanion || companion)) {
        this.models = health.models;
        this.backend = health.backend || defaultBackend(this.entry);
        return true;
      }
      await this.deps.sleep(500);
    }
    return false;
  }

  /** StartLux 伴生进程的 `/health`；404 时回退 `/v1/models`。 */
  private async companionHealth(): Promise<{ models: number; backend: string } | null> {
    const base = systemoneEndpointOf(this.entry);
    const first = await this.probe(`${base}/health`);
    if (first.health) return first.health;
    if (first.status === 404) {
      const fallback = await this.probe(apiUrl(base, '/models'));
      return fallback.health;
    }
    return null;
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
    const withCompanion = isStartLuxEntry(this.entry);
    if (healthPathOf(this.entry.type) === null && !withCompanion) return;
    const health = await this.health();
    const companion = withCompanion ? await this.companionHealth() : null;
    if (this.stopping) return;
    if (health && (!withCompanion || companion)) {
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
      const where = !health ? this.baseUrl() : systemoneEndpointOf(this.entry);
      this.setPhase('error', `health check failed at ${where}`);
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
