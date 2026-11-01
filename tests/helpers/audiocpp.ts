/** 测试用的假进程、假探活与临时 Supervisor。 */
import type { SupervisorDeps, LaunchSpec, ChildLike } from '../../src/supervisor.ts';
import type { AudiocppConfigSection, SupervisorStatus } from '../../src/types.ts';
import { AUDIOCPP_DEFAULTS } from '../../src/config.ts';

export function fakeChild(): ChildLike & { killed: boolean; emitExit(code?: number | null): void } {
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const child = {
    pid: 4242,
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
  return child as unknown as ChildLike & { killed: boolean; emitExit(code?: number | null): void };
}

export interface Harness {
  cfg: AudiocppConfigSection;
  deps: SupervisorDeps;
  launches: LaunchSpec[];
  phases: SupervisorStatus[];
  child: ReturnType<typeof fakeChild>;
  healthy: boolean;
  clock(): number;
  advance(ms: number): void;
}

export function harness(patch: Partial<AudiocppConfigSection> = {}, opts: { adopt?: boolean; healthFails?: number } = {}): Harness {
  const cfg: AudiocppConfigSection = { ...AUDIOCPP_DEFAULTS, enabled: true, serverDir: 'C:/audiocpp', ...patch };
  const launches: LaunchSpec[] = [];
  const phases: SupervisorStatus[] = [];
  const child = fakeChild();
  let clock = 0;
  let failures = opts.healthFails ?? 0;
  let healthy = opts.adopt === true;
  const okBody = JSON.stringify({ status: 'ok', models: 1, backend: 'cuda' });
  const deps: SupervisorDeps = {
    fetch: (async () => {
      if (healthy) return new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } });
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
    cfg, deps, launches, phases, child,
    get healthy() { return healthy; },
    set healthy(value: boolean) { healthy = value; },
    clock: () => clock,
    advance: (ms) => { clock += ms; },
  };
}
