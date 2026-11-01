/**
 * 部署 .env 的最小操作。写入走 WorldContext.storeSecret;框架拒绝空值,
 * 所以面板的「清除令牌」在这里删掉整行并清掉进程环境变量。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeSecretFile } from 'cortico/config-file.ts';

/** .env 一行的变量名;与服务端 writeEnvLine 的判据一致。 */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 删除 .env 中的一行,并去掉本进程里的同名环境变量。文件不存在时什么也不做。 */
export function clearEnvLine(file: string, name: string): void {
  if (!ENV_NAME_RE.test(name)) throw new Error(`"${name}" is not an environment variable name`);
  if (existsSync(file)) {
    const prev = readFileSync(file, 'utf8');
    const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)`, 'm');
    if (pattern.test(prev)) writeSecretFile(file, prev.replace(pattern, ''));
  }
  delete process.env[name];
}
