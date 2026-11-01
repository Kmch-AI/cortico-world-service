/** `worlds.audiocpp` 的默认值、配置组与界面文案。 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language, type LanguageTable } from 'cortico/core/language.ts';
import type { AudiocppConfigSection } from './types.ts';

export const AUDIOCPP_ID = 'audiocpp';

export const AUDIOCPP_DEFAULTS: AudiocppConfigSection = {
  enabled: false,
  manage: true,
  serverDir: '',
  configPath: '',
  binary: '',
  host: '127.0.0.1',
  port: 8000,
  backend: 'cuda',
  device: 0,
  threads: 0,
  autoStart: true,
  restartOnExit: true,
  idleUnloadMs: 0,
  extraArgs: '',
  logFile: '',
  ui: true,
  pollMs: 5000,
  startTimeoutSec: 60,
};

const TEXT = {
  zh: {
    label: 'audiocpp',
    lampProcess: '服务进程',
    lampModels: '模型',
    server: '服务',
    manage: '托管进程',
    manageDesc: '关掉只探活,不拉起服务。',
    serverDir: '服务目录',
    serverDirDesc: '含 audiocpp_server 的目录;也是进程的工作目录。',
    configPath: 'server.json',
    configPathDesc: '留空用服务目录下的 server.json。',
    binary: '可执行文件',
    binaryDesc: '留空按平台取 audiocpp_server(.exe)。',
    host: '监听地址',
    port: '端口',
    backend: '后端',
    device: '设备编号',
    threads: '线程数',
    threadsDesc: '0 用服务默认值。',
    runtime: '运行',
    autoStart: 'World 启动时拉起',
    restartOnExit: '异常退出后重启',
    idleUnloadMs: '空闲卸模型(毫秒)',
    idleUnloadMsDesc: '0 为不卸;只卸模型,不杀进程。',
    extraArgs: '附加参数',
    extraArgsDesc: '按空白分隔。',
    ui: '启用自带 WebUI',
    pollMs: '探活间隔(毫秒)',
    startTimeoutSec: '启动等待(秒)',
    logFile: '日志文件',
    logFileDesc: '留空写到数据目录的 audiocpp.log。',
  },
  en: {
    label: 'audiocpp',
    lampProcess: 'Service process',
    lampModels: 'Models',
    server: 'Service',
    manage: 'Manage the process',
    manageDesc: 'Off means only probe an existing service.',
    serverDir: 'Server directory',
    serverDirDesc: 'Holds audiocpp_server; also the working directory.',
    configPath: 'server.json',
    configPathDesc: 'Empty uses server.json inside the server directory.',
    binary: 'Executable',
    binaryDesc: 'Empty uses audiocpp_server(.exe) for this platform.',
    host: 'Listen address',
    port: 'Port',
    backend: 'Backend',
    device: 'Device index',
    threads: 'Threads',
    threadsDesc: '0 uses the server default.',
    runtime: 'Runtime',
    autoStart: 'Start with the World',
    restartOnExit: 'Restart after an unexpected exit',
    idleUnloadMs: 'Idle model unload (ms)',
    idleUnloadMsDesc: '0 disables; unloads models only, not the process.',
    extraArgs: 'Extra arguments',
    extraArgsDesc: 'Split on whitespace.',
    ui: 'Enable the built-in WebUI',
    pollMs: 'Health interval (ms)',
    startTimeoutSec: 'Start timeout (seconds)',
    logFile: 'Log file',
    logFileDesc: 'Empty writes audiocpp.log in the data directory.',
  },
} as const;

export type AudiocppText = typeof TEXT.zh;

export function audiocppText(language: Language): AudiocppText {
  return pick(language, TEXT as unknown as LanguageTable<AudiocppText>);
}

export function audiocppConfigGroups(language: Language): ConfigGroup[] {
  const t = audiocppText(language);
  const p = 'worlds.audiocpp.';
  return [
    {
      id: 'world:audiocpp-service',
      owner: 'world:audiocpp',
      schema: {
        type: 'object',
        title: t.server,
        properties: {
          [`${p}manage`]: { type: 'boolean', title: t.manage, description: t.manageDesc, 'x-hot': false },
          [`${p}serverDir`]: {
            type: 'string', title: t.serverDir, description: t.serverDirDesc, 'x-hot': false,
            'x-path': { kind: 'directory' },
          },
          [`${p}configPath`]: {
            type: 'string', title: t.configPath, description: t.configPathDesc, 'x-hot': false,
            'x-path': { kind: 'file', extensions: ['json'] },
          },
          [`${p}binary`]: { type: 'string', title: t.binary, description: t.binaryDesc, 'x-hot': false },
          [`${p}host`]: { type: 'string', title: t.host, 'x-hot': false },
          [`${p}port`]: { type: 'integer', title: t.port, minimum: 1, maximum: 65535, 'x-hot': false },
          [`${p}backend`]: { type: 'string', title: t.backend, enum: ['cuda', 'cpu', 'vulkan', 'hip', 'metal'], 'x-hot': false },
          [`${p}device`]: { type: 'integer', title: t.device, minimum: 0, maximum: 32, 'x-hot': false },
          [`${p}threads`]: { type: 'integer', title: t.threads, description: t.threadsDesc, minimum: 0, maximum: 256, 'x-hot': false },
        },
      },
    },
    {
      id: 'world:audiocpp-runtime',
      owner: 'world:audiocpp',
      schema: {
        type: 'object',
        title: t.runtime,
        properties: {
          [`${p}autoStart`]: { type: 'boolean', title: t.autoStart, 'x-hot': false },
          [`${p}restartOnExit`]: { type: 'boolean', title: t.restartOnExit, 'x-hot': false },
          [`${p}idleUnloadMs`]: { type: 'integer', title: t.idleUnloadMs, description: t.idleUnloadMsDesc, minimum: 0, maximum: 86_400_000, 'x-hot': false },
          [`${p}extraArgs`]: { type: 'string', title: t.extraArgs, description: t.extraArgsDesc, 'x-hot': false },
          [`${p}ui`]: { type: 'boolean', title: t.ui, 'x-hot': false },
          [`${p}pollMs`]: { type: 'integer', title: t.pollMs, minimum: 1000, maximum: 120_000, 'x-hot': false },
          [`${p}startTimeoutSec`]: { type: 'integer', title: t.startTimeoutSec, minimum: 5, maximum: 600, 'x-hot': false },
          [`${p}logFile`]: {
            type: 'string', title: t.logFile, description: t.logFileDesc, 'x-hot': false,
            'x-path': { kind: 'file', extensions: ['log', 'txt'] },
          },
        },
      },
    },
  ];
}
