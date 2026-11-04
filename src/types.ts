/** 服务 World 的配置、服务条目与状态类型。 */

export type Phase = 'off' | 'starting' | 'online' | 'error';
export type Backend = 'cuda' | 'cpu' | 'vulkan' | 'hip' | 'metal';
/** 0.1.x 的旧名,等同 {@link Backend}。 */
export type AudiocppBackend = Backend;

/**
 * 服务类型：启动预设与条目自身端点的 HTTP 方言，见 `protocolOf`。
 * 它不是路由能力；`/v1/systemone`、`/v1/embeddings`、`/v1/rerank` 按 `ServiceEntry.tasks` 选条目。
 */
export type ServiceType = 'audiocpp' | 'openai' | 'sing' | 'llamacpp' | 'systemone' | 'svc' | 'custom';

/** HTTP 方言。`none` 表示只托管进程,不代理请求(保留给未来没有 HTTP 端点的类型)。 */
export type ServiceProtocol = 'audiocpp' | 'openai' | 'custom' | 'sing' | 'systemone' | 'llamacpp' | 'none';

/** `worlds.service.services` 的一项。 */
export interface ServiceEntry {
  /** 服务端生成的稳定键;日志、状态与 API 路径用它。 */
  id: string;
  /** 用户填写的唯一身份。 */
  name: string;
  type: ServiceType;
  enabled: boolean;
  /** 一个 URL,例如 `http://127.0.0.1:8080` 或 `https://host/v1`。 */
  endpoint: string;
  /** false = 只探活,不拉起进程。 */
  manage: boolean;
  /** World 启动时一并拉起。 */
  autoStart: boolean;
  /** 进程非预期退出后自动重启。 */
  restartOnExit: boolean;
  /** 可执行文件所在目录,也是进程的工作目录。 */
  serverDir?: string;
  /** 可执行文件;相对路径按 serverDir 解析,留空按 type 取预设名。 */
  binary?: string;
  /** 追加到命令行的参数,按空白分隔(支持引号)。 */
  args?: string;
  /** 上游 Bearer token 的 .env 变量名。 */
  secretName?: string;
  /** 'auto' 或内置 profile id。 */
  modelProfile?: string;
  /** 空 = 从 /v1/models 现取。 */
  models?: string[];
  /**
   * 该模型承载的任务；空 = 按 type 推导。`systemone` 与 `embeddings` / `rerank` 同级。
   * 一个条目就是一个模型部署，llama.cpp 条目可以用 `['systemone']` 表示 StartLux。
   */
  tasks?: string[];
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
  /** 伴生进程 PID；llama.cpp 条目托管 StartLux 时是 startlux-decide。 */
  companionPid?: number | null;
  /** 该条目的有效模型任务（显式 tasks 或类型默认）。 */
  tasks: string[];
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
  description?: string;
  values?: string[];
  default?: unknown;
  min?: number;
  max?: number;
  /** false = 只由语音语义控制,不在模型参数面板里单独暴露。 */
  ui?: boolean;
}

export interface ModelProfileSpeedLevel {
  max: number;
  value: string;
}

/** 模型差异用数据表达:新增模型只加 profile,不改代码。 */
export interface ModelProfile {
  id: string;
  label: string;
  protocol: Exclude<ServiceProtocol, 'none'>;
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

export type ModelParameterType =
  | 'string'
  | 'enum'
  | 'bool'
  | 'int'
  | 'float'
  | 'string_list'
  | 'path'
  | 'path_list';

/** 模型请求参数的元数据;来自 `model_specs/*.json` 的 `options.request`。 */
export interface ModelParameter {
  name: string;
  type: ModelParameterType;
  description?: string;
  values?: string[];
  default?: unknown;
  min?: number;
  max?: number;
}

/** 服务目录里的一项模型;`service` 是拥有它的条目 id。 */
export interface ModelRecord {
  id: string;
  label?: string;
  voices: string[];
  /** 展示与模型页用的任务元数据；路由以条目的有效 tasks 为准。 */
  tasks: string[];
  service: string;
  source: 'config' | 'api' | 'spec';
  /** server.json 声明的模型族;用来匹配 model_specs 里的元数据。 */
  family?: string;
  /** 上游请求参数;只含该模型真正接受的字段。 */
  parameters?: ModelParameter[];
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

/** 上游 JSON 回应;状态码保留,正文原样交给网关。 */
export interface JsonResult {
  status: number;
  body: unknown;
}

/** 网关收到的 `POST /v1/systemone`;`body` 原样转发。 */
export interface SystemOneRequest {
  model?: string;
  body: Record<string, unknown>;
}

/** 网关收到的 `POST /v1/embeddings`;`input` 与其余字段原样转发。 */
export interface EmbeddingsRequest {
  model?: string;
  /** 字符串或数组(字符串、token id 或它们的组合)。 */
  input: unknown;
  dimensions?: number;
  body: Record<string, unknown>;
}

/** 网关收到的 `POST /v1/rerank`;`documents` 原样转发。 */
export interface RerankRequest {
  model?: string;
  query: string;
  documents: unknown[];
  top_n?: number;
  body: Record<string, unknown>;
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
