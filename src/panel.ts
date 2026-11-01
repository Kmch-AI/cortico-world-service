/** 服务面板与 World 经由 `invoke` 交换的数据形状;浏览器端 import type 这些声明,并直接使用 `SERVICE_TYPES`。 */
import type {
  GatewayPhase, ModelRecord, ServiceCatalog, ServiceEntry, ServiceStatus,
} from './types.ts';

/** 条目的 id 在日志文件名与服务键里使用;只允许字母、数字、点、下划线与连字符。 */
export const SERVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 服务类型;协议由 `protocolOf` 推导,不再单独配置。 */
export const SERVICE_TYPES = ['audiocpp', 'openai', 'sing', 'llamacpp', 'systemone', 'svc', 'custom'] as const;

/** 条目加上「令牌是否有值」;令牌值本身从不过桥。 */
export interface PanelServiceEntry extends ServiceEntry {
  tokenSet: boolean;
}

/** 一个条目的运行状态;`entry` 带 tokenSet。 */
export interface PanelService extends Omit<ServiceStatus, 'entry'> {
  entry: PanelServiceEntry;
}

/** 网关标量与状态;`secretName` 只是变量名,不是值。 */
export interface PanelGateway {
  enabled: boolean;
  /** 与 `status` 同义,便于按 phase 命名读取。 */
  status: GatewayPhase;
  phase: GatewayPhase;
  ready: boolean;
  detail: string;
  host: string;
  port: number;
  baseUrl: string;
  version: string;
  uptimeSec: number;
  tokenRequired: boolean;
  tokenSet: boolean;
  secretName: string;
  allowQueryToken: boolean;
  requestTimeoutSec: number;
  defaultSpeechModel: string;
  /** 网关已在运行,但 host / port / tokenSecret 与监听时不同;重启 World 才生效。 */
  restartRequired: boolean;
  models: number;
  online: number;
  total: number;
}

export interface PanelState {
  gateway: PanelGateway;
  services: PanelService[];
}

/** `models` 与 `discover` 的返回:扁平模型表加每个条目的目录快照。 */
export interface PanelModels {
  models: ModelRecord[];
  services: ServiceCatalog[];
}

export interface PanelLogs {
  id: string;
  lines: number;
  text: string;
}

/** `setToken` 只回令牌是否有值。 */
export interface PanelTokenResult {
  tokenSet: boolean;
}
