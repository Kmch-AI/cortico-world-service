/** 服务面板与 World 经由 `invoke` 交换的数据形状;浏览器端 import type 这些声明,并直接使用 `SERVICE_TYPES`。 */
import type {
  GatewayPhase, ModelRecord, ServiceCatalog, ServiceEntry, ServiceStatus, ServiceType,
} from './types.ts';

/** 条目的 id 在日志文件名与服务键里使用;只允许字母、数字、点、下划线与连字符。 */
export const SERVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 服务类型;协议由 `protocolOf` 推导,不再单独配置。顺序按页面用途分组。 */
export const SERVICE_TYPES = ['audiocpp', 'sing', 'openai', 'llamacpp', 'startlux', 'systemone'] as const;

/** 导入导出文件的格式标记与版本;格式变更时升版本并拒绝旧文件。 */
export const CONFIG_BUNDLE_FORMAT = 'cortico-world-service';
export const CONFIG_BUNDLE_VERSION = 1;

/** 导出文件里的网关标量;字段与 `worlds.service` 同名。 */
export interface PanelConfigGateway {
  enabled: boolean;
  host: string;
  port: number;
  tokenSecret: string;
  allowQueryToken: boolean;
  requestTimeoutSec: number;
  defaultSpeechModel: string;
}

/** 导出/导入的全部配置。令牌只带变量名,不带值。 */
export interface PanelConfigBundle {
  format: typeof CONFIG_BUNDLE_FORMAT;
  version: typeof CONFIG_BUNDLE_VERSION;
  packageVersion: string;
  gateway: PanelConfigGateway;
  services: ServiceEntry[];
}

/** 类型的显示名;配置里仍用 {@link SERVICE_TYPES} 的小写键。 */
export const SERVICE_TYPE_LABELS: Readonly<Record<ServiceType, string>> = {
  audiocpp: 'audiocpp',
  sing: 'Sing',
  openai: 'OpenAI',
  llamacpp: 'llama.cpp',
  startlux: 'StartLux Decision',
  systemone: 'SystemOne',
};

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
