/**
 * 多服务编排:按条目 id 持有 Supervisor,顺序启动、逆序停止。
 * 配置是 World 里的活 services 数组;改写经 World 给的 persist 回调,管理器不碰 ctx。
 */
import { readFile } from 'node:fs/promises';
import type { Logger } from 'cortico/core/types.ts';
import {
  idleServiceStatus, serviceLogPath, Supervisor, type SupervisorDeps,
} from './supervisor.ts';
import type { ServiceEntry, ServiceStatus } from './types.ts';

/** 活配置数组,或每次读取它的 getter。 */
export type ServiceListSource = readonly ServiceEntry[] | (() => readonly ServiceEntry[]);

export interface ManagerOptions {
  /** 活配置段;管理器读取它的 services 数组。与 services / entries 二选一。 */
  cfg?: { services?: readonly ServiceEntry[] };
  /** 活服务数组或 getter;优先于 cfg。 */
  services?: ServiceListSource;
  /** `services` 的别名。 */
  entries?: ServiceListSource;
  dataDir: string;
  log: Logger;
  /** World 提供的写回:整体替换 `worlds.service.services`。 */
  persist?(services: ServiceEntry[]): void;
  deps?: Partial<SupervisorDeps>;
  /** Supervisor 状态变化;World 用它推只归档事件。 */
  onStatus?(status: ServiceStatus): void;
  /** logs() 默认返回的行数。 */
  logLines?: number;
}

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 5000;

/** 从 services 数组尾部取日志。 */
function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(-lines).join('\n');
}

export class Manager {
  private readonly supervisors = new Map<string, Supervisor>();
  private readonly log: Logger;

  constructor(private readonly opts: ManagerOptions) {
    this.log = opts.log;
  }

  /** 当前配置的条目,按配置顺序。 */
  entries(): readonly ServiceEntry[] {
    const source = this.opts.services ?? this.opts.entries;
    if (typeof source === 'function') return source();
    return source ?? this.opts.cfg?.services ?? [];
  }

  private find(id: string): ServiceEntry | undefined {
    return this.entries().find((entry) => entry.id === id);
  }

  private supervisorFor(entry: ServiceEntry): Supervisor {
    const existing = this.supervisors.get(entry.id);
    if (existing) {
      existing.setEntry(entry);
      return existing;
    }
    const supervisor = new Supervisor({
      entry,
      dataDir: this.opts.dataDir,
      log: this.log,
      peers: () => this.entries(),
      deps: {
        ...this.opts.deps,
        onPhase: (status) => {
          this.opts.deps?.onPhase?.(status);
          this.opts.onStatus?.(status);
        },
      },
    });
    this.supervisors.set(entry.id, supervisor);
    return supervisor;
  }

  /** 依次启动 enabled 且 autoStart 的条目;其余 enabled 条目只探活。 */
  async startAll(): Promise<ServiceStatus[]> {
    const statuses: ServiceStatus[] = [];
    for (const entry of this.entries()) {
      if (!entry.enabled) continue;
      const supervisor = this.supervisorFor(entry);
      if (entry.autoStart) await supervisor.start();
      else await supervisor.refresh();
      statuses.push(supervisor.status());
    }
    return statuses;
  }

  /** 逆序停止所有已创建的服务。 */
  async stopAll(): Promise<ServiceStatus[]> {
    const statuses: ServiceStatus[] = [];
    const seen = new Set<string>();
    for (const entry of [...this.entries()].reverse()) {
      seen.add(entry.id);
      const supervisor = this.supervisors.get(entry.id);
      if (!supervisor) continue;
      supervisor.setEntry(entry);
      await supervisor.stop();
      statuses.push(supervisor.status());
    }
    for (const [id, supervisor] of [...this.supervisors]) {
      if (seen.has(id)) continue;
      await supervisor.stop();
      statuses.push(supervisor.status());
    }
    return statuses;
  }

  /** 对 enabled 条目开始周期探活;不拉起进程。 */
  watchAll(): void {
    for (const entry of this.entries()) {
      if (!entry.enabled) continue;
      this.supervisorFor(entry).watch();
    }
  }

  async start(id: string): Promise<ServiceStatus | null> {
    const entry = this.find(id);
    if (!entry) return null;
    const supervisor = this.supervisorFor(entry);
    await supervisor.start();
    return supervisor.status();
  }

  async stop(id: string): Promise<ServiceStatus | null> {
    const entry = this.find(id);
    const supervisor = this.supervisors.get(id);
    if (!entry && !supervisor) return null;
    if (supervisor) {
      if (entry) supervisor.setEntry(entry);
      await supervisor.stop();
      return supervisor.status();
    }
    return entry ? idleServiceStatus(entry) : null;
  }

  async restart(id: string): Promise<ServiceStatus | null> {
    await this.stop(id);
    return this.start(id);
  }

  /** 每个配置条目一份状态;没启动过的条目也返回完整结构。 */
  status(): ServiceStatus[] {
    return this.entries().map((entry) => {
      const supervisor = this.supervisors.get(entry.id);
      if (!supervisor) return idleServiceStatus(entry);
      supervisor.setEntry(entry);
      return supervisor.status();
    });
  }

  statusOf(id: string): ServiceStatus | null {
    const entry = this.find(id);
    if (!entry) return null;
    const supervisor = this.supervisors.get(id);
    if (!supervisor) return idleServiceStatus(entry);
    supervisor.setEntry(entry);
    return supervisor.status();
  }

  /** 只探一次活,不拉起进程,也不改配置。 */
  async probe(id: string): Promise<ServiceStatus | null> {
    const entry = this.find(id);
    if (!entry) return null;
    const supervisor = this.supervisorFor(entry);
    await supervisor.refresh();
    return supervisor.status();
  }

  /** 日志尾部;文件不存在时返回空串。 */
  async logs(id: string, lines = this.opts.logLines ?? DEFAULT_LOG_LINES): Promise<string> {
    const entry = this.find(id);
    if (!entry) return '';
    const count = Number.isFinite(lines)
      ? Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(lines)))
      : DEFAULT_LOG_LINES;
    try {
      return tail(await readFile(serviceLogPath(entry, this.opts.dataDir), 'utf8'), count);
    } catch {
      return '';
    }
  }

  /** 整体替换 services:先写回配置,再停掉被删或停用的条目并同步条目引用。 */
  async setServices(next: readonly ServiceEntry[]): Promise<void> {
    this.opts.persist?.(next.map((entry) => ({ ...entry })));
    await this.sync();
  }

  /** 让 Supervisor 跟随活配置:被删或停用的条目停止,其余换上新条目对象。 */
  async sync(): Promise<void> {
    const live = new Map<string, ServiceEntry>();
    for (const entry of this.entries()) live.set(entry.id, entry);
    for (const [id, supervisor] of [...this.supervisors]) {
      const entry = live.get(id);
      if (!entry) {
        await supervisor.stop();
        this.supervisors.delete(id);
        continue;
      }
      supervisor.setEntry(entry);
      if (!entry.enabled) await supervisor.stop();
    }
  }
}
