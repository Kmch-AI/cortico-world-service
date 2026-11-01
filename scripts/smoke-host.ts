/**
 * 用真的 audiocpp_server 跑一遍托管:拉起、探活、停止。
 * 用法:`pnpm smoke:host <serverDir> [port] [dataDir]`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { AUDIOCPP_DEFAULTS } from '../src/config.ts';
import { Supervisor } from '../src/supervisor.ts';

const serverDir = process.argv[2];
if (!serverDir) {
  console.error('usage: pnpm smoke:host <serverDir> [port] [dataDir]');
  process.exit(2);
}
const port = Number(process.argv[3] ?? 8018);
const dataDir = process.argv[4] ?? mkdtempSync(join(tmpdir(), 'audiocpp-host-'));
const ownData = process.argv[4] === undefined;
const cfg = {
  ...AUDIOCPP_DEFAULTS,
  enabled: true,
  serverDir,
  port,
  backend: 'cuda' as const,
  ui: false,
  startTimeoutSec: 120,
};
const sup = new Supervisor({ cfg, dataDir, log: nullLogger() });
try {
  const started = Date.now();
  await sup.start();
  console.log('after start:', sup.status(), `${Date.now() - started} ms`);
  if (sup.status().phase !== 'online') process.exitCode = 1;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await sup.refresh();
  console.log('after refresh:', sup.status());
} finally {
  await sup.stop();
  console.log('after stop:', sup.status());
  if (ownData) rmSync(dataDir, { recursive: true, force: true });
}
