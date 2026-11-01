/**
 * 面板 bundle:`webui/client.ts` → `dist/webui.js` + `dist/webui.css`。
 * 两个文件名写在 package.json 的 cortico.webUiClient / cortico.webUiStyle 里,
 * 服务端按 manifest 分配 URL。
 *
 * `cortico/*` 在浏览器侧只允许 import type,编译期就擦掉;这里不配 alias 也不
 * external。构建若报 "Could not resolve cortico/…",说明有一处运行时依赖漏网。
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
