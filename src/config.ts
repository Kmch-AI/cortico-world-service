/** `worlds.service` 的默认值、配置组与界面文案。 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language, type LanguageTable } from 'cortico/core/language.ts';
import type { ServiceConfigSection } from './types.ts';

export const SERVICE_ID = 'service';
export const SERVICE_VERSION = '0.1.0';

export const SERVICE_DEFAULTS: ServiceConfigSection = {
  enabled: false,
  host: '127.0.0.1',
  port: 9883,
  tokenSecret: '',
  allowQueryToken: false,
  requestTimeoutSec: 180,
  defaultSpeechModel: '',
  services: [],
};

const TEXT = {
  zh: {
    label: '服务',
    panelServices: '服务',
    lampGateway: '网关',
    lampServices: '服务',
    lampModels: '模型',
    gateway: '网关',
    gatewayDesc: '本机推理服务的统一 HTTP 入口。',
    enabled: '启用',
    host: '监听地址',
    hostDesc: '只应对外暴露时再改;非回环地址需要令牌。',
    port: '端口',
    tokenSecret: '令牌变量名',
    tokenSecretDesc: '部署 .env 里的变量名;留空表示本机免认证。',
    allowQueryToken: '允许查询参数令牌',
    allowQueryTokenDesc: '开启后也接受 ?token=;默认只认 Authorization 头。',
    request: '请求',
    requestTimeoutSec: '上游超时(秒)',
    defaultSpeechModel: '默认语音模型',
    defaultSpeechModelDesc: '请求不带 model 时用它;留空按服务顺序取第一个可用模型。',
  },
  en: {
    label: 'Service',
    panelServices: 'Services',
    lampGateway: 'Gateway',
    lampServices: 'Services',
    lampModels: 'Models',
    gateway: 'Gateway',
    gatewayDesc: 'One HTTP entry for local inference services.',
    enabled: 'Enabled',
    host: 'Listen address',
    hostDesc: 'Only change it to expose the gateway; a non-loopback address needs a token.',
    port: 'Port',
    tokenSecret: 'Token variable',
    tokenSecretDesc: 'A deployment .env variable name; empty means no auth on loopback.',
    allowQueryToken: 'Accept a query token',
    allowQueryTokenDesc: 'Also accept ?token=; the Authorization header is the default.',
    request: 'Requests',
    requestTimeoutSec: 'Upstream timeout (seconds)',
    defaultSpeechModel: 'Default speech model',
    defaultSpeechModelDesc: 'Used when a request omits model; empty picks the first available model in service order.',
  },
} as const;

export type ServiceText = typeof TEXT.zh;

export function serviceText(language: Language): ServiceText {
  return pick(language, TEXT as unknown as LanguageTable<ServiceText>);
}

export function serviceConfigGroups(language: Language): ConfigGroup[] {
  const t = serviceText(language);
  const p = 'worlds.service.';
  return [
    {
      id: 'world:service-gateway',
      owner: 'world:service',
      schema: {
        type: 'object',
        title: t.gateway,
        description: t.gatewayDesc,
        properties: {
          [`${p}enabled`]: { type: 'boolean', title: t.enabled, 'x-hot': false },
          [`${p}host`]: { type: 'string', title: t.host, description: t.hostDesc, 'x-hot': false },
          [`${p}port`]: { type: 'integer', title: t.port, minimum: 1, maximum: 65535, 'x-hot': false },
          [`${p}tokenSecret`]: {
            type: 'string', title: t.tokenSecret, description: t.tokenSecretDesc, 'x-hot': false,
          },
          [`${p}allowQueryToken`]: { type: 'boolean', title: t.allowQueryToken, description: t.allowQueryTokenDesc, 'x-hot': false },
        },
      },
    },
    {
      id: 'world:service-request',
      owner: 'world:service',
      schema: {
        type: 'object',
        title: t.request,
        properties: {
          [`${p}requestTimeoutSec`]: {
            type: 'integer', title: t.requestTimeoutSec, minimum: 5, maximum: 3600,
          },
          [`${p}defaultSpeechModel`]: {
            type: 'string', title: t.defaultSpeechModel, description: t.defaultSpeechModelDesc,
          },
        },
      },
    },
  ];
}
