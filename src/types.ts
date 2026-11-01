/** 服务 World 的配置、服务条目与状态类型。 */

export type Phase = 'off' | 'starting' | 'online' | 'error';
export type Backend = 'cuda' | 'cpu' | 'vulkan' | 'hip' | 'metal';
/** 0.1.x 的旧名,等同 {@link Backend}。 */
export type AudiocppBackend = Backend;

/** 进程托管与启动预设。`custom` 不套用任何内置启动参数。 */
export type ServiceKind = 'audiocpp' | 'llamacpp' | 'systemone' | 'svc' | 'custom';

/** HTTP 方言。`none` 表示只托管进程,不代理请求。 */
export type ServiceProtocol = 'audiocpp' | 'openai' | 'custom' | 'sing' | 'none';

/** `worlds.service.services` 的一项。`kind` 决定启动预设,`protocol` 决定 HTTP 方言。 */
export interface ServiceEntry {
  id: string;
  label?: string;
  kind: ServiceKind;
  protocol: ServiceProtocol;
  enabled: boolean;
  /** false = 只探活,不拉起进程。 */
  manage: boolean;
  /** World 启动时一并拉起。 */
  autoStart: boolean;
  /** 进程非预期退出后自动重启。 */
  restartOnExit: boolean;
  host?: string;
  port?: number;
  /** 远程端点;留空按 host:port。 */
  baseUrl?: string;
  /** 探活路径;留空按 kind。 */
  healthPath?: string;
  /** 可执行文件所在目录,也是进程的工作目录。 */
  serverDir?: string;
  /** 可执行文件;相对路径按 serverDir 解析,留空按 kind 取默认名。 */
  binary?: string;
  configPath?: string;
  /** 追加到命令行的参数,按空白分隔(支持引号)。 */
  args?: string;
  /** 上游 Bearer token 的 .env 变量名。 */
  secretName?: string;
  /** 'auto' 或内置/自定义 profile id。 */
  modelProfile?: string;
  /** 面板里的模型 profile 覆盖;按 id 键,只存覆盖字段。 */
  modelProfiles?: Record<string, Partial<ModelProfile>>;
  /** 空 = 从 /v1/models 现取。 */
  models?: string[];
  /** 该服务的默认 options。 */
  options?: Record<string, unknown>;
}

/** 一个服务条目的运行状态;`entry` 是配置里的活条目。 */
export interface ServiceStatus {
  entry: ServiceEntry;
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

/** 旧名,等同 {@link ServiceStatus}。 */
export type SupervisorStatus = ServiceStatus;

/** 服务网关(HTTP 协议层)的状态。 */
export type GatewayPhase = 'off' | 'starting' | 'ok' | 'degraded' | 'error';

export interface GatewayStatus {
  /** 与 /health 的 `status` 同义;`off` 只在 World 未启动时出现。 */
  status: GatewayPhase;
  /** `status` 的别名,便于状态灯按 phase 命名读取。 */
  phase: GatewayPhase;
  /** 至少有一个服务在线,可以接语音请求。 */
  ready: boolean;
  detail: string;
  host: string;
  port: number;
  baseUrl: string;
  version: string;
  uptimeSec: number;
  services: ServiceStatus[];
  models: number;
}

export type ModelField =
  | 'text'
  | 'voice'
  | 'model'
  | 'format'
  | 'speed'
  | 'instruct'
  | 'emotion'
  | 'language'
  | 'speedLevel';

export interface ModelProfileVariant {
  id: string;
  when: Record<string, unknown>;
  set: Record<string, unknown>;
}

export interface ModelProfileOption {
  name: string;
  type: 'string' | 'enum' | 'bool' | 'int' | 'float';
  values?: string[];
  default?: unknown;
}

export interface ModelProfileSpeedLevel {
  max: number;
  value: string;
}

/** 模型差异用数据表达:新增模型只加 profile,不改代码。 */
export interface ModelProfile {
  id: string;
  label: string;
  protocol: 'audiocpp' | 'openai' | 'custom' | 'sing';
  /** 模型 id 前缀/通配;'*' 兜底。 */
  match?: string[];
  /** 请求字段到上游字段的映射。 */
  fields?: Partial<Record<ModelField, string>>;
  variants?: ModelProfileVariant[];
  options?: ModelProfileOption[];
  defaults?: Record<string, unknown>;
  speedLevels?: ModelProfileSpeedLevel[];
  /** 该模型是否支持副语言标签。 */
  tags?: boolean;
  formats?: Array<'wav' | 'mp3'>;
}

export type AudioFormat = 'wav' | 'mp3';

/** 一段合成音频。`seconds` 只用于日志与回执,不是所有格式都能算。 */
export interface TtsAudio {
  bytes: Uint8Array;
  mime: string;
  seconds?: number;
}

export interface VoiceOption {
  value: string;
  label: string;
}

/** 服务目录里的一项模型;`service` 是拥有它的条目 id。 */
export interface ModelRecord {
  id: string;
  label?: string;
  voices: string[];
  tasks: string[];
  service: string;
  source: 'config' | 'api' | 'spec';
}

/** 一个服务条目的最近一次发现结果;失败时保留上次结果并标 stale。 */
export interface ServiceCatalog {
  service: string;
  models: ModelRecord[];
  stale: boolean;
  detail: string;
  updatedAt: number;
}

/** 网关收到的 `POST /v1/audio/speech` 请求。 */
export interface SpeechRequest {
  model?: string;
  input: string;
  voice?: string;
  format: AudioFormat;
  speed?: number;
  instructions?: string;
  emotion?: string;
  language?: string;
  options?: Record<string, unknown>;
}

/** 网关收到的 `POST /v1/audio/sing` 请求。 */
export interface SingRequest {
  model?: string;
  lyrics: string;
}

/** `worlds.service` 的配置段。 */
export interface ServiceConfigSection {
  enabled: boolean;
  host: string;
  port: number;
  /** 部署 .env 里的变量名;留空表示本机免认证。 */
  tokenSecret: string;
  /** 也接受 `?token=`;默认只认 Authorization 头。 */
  allowQueryToken: boolean;
  requestTimeoutSec: number;
  defaultSpeechModel: string;
  /** 服务条目数组;不在 ConfigGroup 里,由服务面板整体写回。 */
  services: ServiceEntry[];
}
