/** audiocpp 托管 World 的配置与状态类型。 */

export type AudiocppBackend = 'cuda' | 'cpu' | 'vulkan' | 'hip' | 'metal';
export type Phase = 'off' | 'starting' | 'online' | 'error';

/** `config.json` 的 `worlds.audiocpp` 段。 */
export interface AudiocppConfigSection {
  enabled: boolean;
  /** false 只探活,不拉起进程。 */
  manage: boolean;
  /** 含 audiocpp_server 可执行文件的目录;进程的工作目录也是它。 */
  serverDir: string;
  /** server.json 的路径;留空用 serverDir/server.json。 */
  configPath: string;
  /** 可执行文件名;留空按平台取 audiocpp_server(.exe)。 */
  binary: string;
  host: string;
  port: number;
  backend: AudiocppBackend;
  device: number;
  threads: number;
  /** World 启动时一并拉起服务。 */
  autoStart: boolean;
  /** 进程非预期退出后自动重启。 */
  restartOnExit: boolean;
  /** 服务端空闲多久卸模型(毫秒);0 为不卸。 */
  idleUnloadMs: number;
  /** 追加到命令行的参数,按空白分隔。 */
  extraArgs: string;
  /** 服务输出写到哪个文件;留空写到数据目录的 audiocpp.log。 */
  logFile: string;
  /** 使用服务自带的 WebUI。 */
  ui: boolean;
  /** 探活间隔(毫秒)。 */
  pollMs: number;
  /** 启动等待上限(秒)。 */
  startTimeoutSec: number;
}

export interface SupervisorStatus {
  phase: Phase;
  /** 状态说明;错误时是原因。 */
  detail: string;
  /** 服务不是本 World 拉起的。 */
  external: boolean;
  managed: boolean;
  pid: number | null;
  models: number;
  backend: string;
  baseUrl: string;
  restarts: number;
}
