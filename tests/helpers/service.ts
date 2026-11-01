/** 测试用的假进程、假探活与临时 Supervisor。 */
import { isAbsolute, join } from 'node:path';
import { endpointUrl } from '../../src/entry.ts';
import type { SupervisorDeps, LaunchSpec, ChildLike } from '../../src/supervisor.ts';
import type { ServiceEntry, ServiceStatus } from '../../src/types.ts';

export type FakeChild = ChildLike & { killed: boolean; emitExit(code?: number | null): void };

export function fakeChild(pid = 4242): FakeChild {
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const child = {
    pid,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    killed: false,
    once(event: 'exit' | 'error', cb: (...args: never[]) => void) {
      if (event === 'exit') exits.push(cb as never);
      else errors.push(cb as never);
      return child;
    },
    kill() {
      child.killed = true;
      for (const cb of exits.splice(0)) cb(null, 'SIGTERM');
      return true;
    },
    emitExit(code: number | null = 1) {
      for (const cb of exits.splice(0)) cb(code, null);
    },
  };
  return child as unknown as FakeChild;
}

/** 服务条目的测试默认值;audiocpp 预设沿用 0.1.x。 */
export function serviceEntry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'audiocpp',
    name: 'audiocpp',
    type: 'audiocpp',
    enabled: true,
    endpoint: 'http://127.0.0.1:8000',
    manage: true,
    autoStart: true,
    restartOnExit: true,
    serverDir: 'C:/audiocpp',
    options: { backend: 'cuda', device: 0, threads: 0, idleUnloadMs: 0, ui: true },
    ...patch,
  };
}

function commandOf(entry: ServiceEntry): string | null {
  const raw = entry.binary?.trim();
  if (!raw) return null;
  return isAbsolute(raw) || !entry.serverDir?.trim() ? raw : join(entry.serverDir.trim(), raw);
}

function okBody(models: number): string {
  return JSON.stringify({ status: 'ok', models, backend: 'cuda' });
}

function healthyResponse(models: number): Response {
  return new Response(okBody(models), { status: 200, headers: { 'content-type': 'application/json' } });
}

export interface Harness {
  entry: ServiceEntry;
  deps: SupervisorDeps;
  launches: LaunchSpec[];
  phases: ServiceStatus[];
  child: FakeChild;
  healthy: boolean;
  clock(): number;
  advance(ms: number): void;
}

export function harness(
  patch: Partial<ServiceEntry> = {},
  opts: { adopt?: boolean; healthFails?: number; models?: number } = {},
): Harness {
  const entry = serviceEntry(patch);
  const launches: LaunchSpec[] = [];
  const phases: ServiceStatus[] = [];
  const child = fakeChild();
  const models = opts.models ?? 1;
  let clock = 0;
  let failures = opts.healthFails ?? 0;
  let healthy = opts.adopt === true;
  const deps: SupervisorDeps = {
    fetch: (async () => {
      if (healthy) return healthyResponse(models);
      if (failures > 0) {
        failures -= 1;
        if (failures === 0) healthy = true;
        return new Response('no', { status: 503 });
      }
      return new Response('no', { status: 503 });
    }) as typeof fetch,
    launch: (spec) => { launches.push(spec); return child; },
    exists: () => true,
    mkdir: () => {},
    openLog: () => ({ write: () => {}, close: () => {} }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onPhase: (status) => { phases.push(status); },
  };
  return {
    entry, deps, launches, phases, child,
    get healthy() { return healthy; },
    set healthy(value: boolean) { healthy = value; },
    clock: () => clock,
    advance: (ms) => { clock += ms; },
  };
}

interface Fixture {
  entry: ServiceEntry;
  healthy: boolean;
  failures: number;
  launches: number;
}

export interface MultiHarness {
  services: ServiceEntry[];
  deps: SupervisorDeps;
  launches: LaunchSpec[];
  phases: ServiceStatus[];
  children: FakeChild[];
  setHealthy(id: string, value: boolean): void;
  clock(): number;
  advance(ms: number): void;
}

/** 多条目测试:按 endpointUrl 区分探活,按命令行匹配被拉起的进程。 */
export function multiHarness(
  entries: ServiceEntry[],
  opts: { adopt?: boolean | string[]; healthFails?: number; models?: number; healthyOnLaunch?: boolean } = {},
): MultiHarness {
  const adopted = new Set(
    Array.isArray(opts.adopt) ? opts.adopt : opts.adopt === true ? entries.map((entry) => entry.id) : [],
  );
  const fixtures: Fixture[] = entries.map((entry) => ({
    entry,
    healthy: adopted.has(entry.id),
    failures: opts.healthFails ?? 0,
    launches: 0,
  }));
  const byBase = [...fixtures]
    .map((fixture) => ({ fixture, base: endpointUrl(fixture.entry) }))
    .sort((a, b) => b.base.length - a.base.length);
  const byCommand = new Map<string, Fixture>();
  for (const fixture of fixtures) {
    const command = commandOf(fixture.entry);
    if (command) byCommand.set(command, fixture);
  }

  const launches: LaunchSpec[] = [];
  const phases: ServiceStatus[] = [];
  const children: FakeChild[] = [];
  const models = opts.models ?? 1;
  let clock = 0;

  const deps: SupervisorDeps = {
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const match = byBase.find(({ base }) => url.startsWith(base));
      if (!match) return new Response('no', { status: 503 });
      const fixture = match.fixture;
      if (fixture.healthy) return healthyResponse(models);
      if (fixture.failures > 0) {
        fixture.failures -= 1;
        if (fixture.failures === 0) fixture.healthy = true;
        return new Response('no', { status: 503 });
      }
      return new Response('no', { status: 503 });
    }) as typeof fetch,
    launch: (spec) => {
      launches.push(spec);
      const fixture = byCommand.get(spec.command)
        ?? fixtures.find((item) => item.launches === 0)
        ?? fixtures[0]!;
      fixture.launches += 1;
      if (opts.healthyOnLaunch) fixture.healthy = true;
      const child = fakeChild(4242 + launches.length);
      children.push(child);
      return child;
    },
    exists: () => true,
    mkdir: () => {},
    openLog: () => ({ write: () => {}, close: () => {} }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onPhase: (status) => { phases.push(status); },
  };

  return {
    services: entries,
    deps,
    launches,
    phases,
    children,
    setHealthy: (id, value) => {
      const fixture = fixtures.find((item) => item.entry.id === id);
      if (fixture) fixture.healthy = value;
    },
    clock: () => clock,
    advance: (ms) => { clock += ms; },
  };
}
