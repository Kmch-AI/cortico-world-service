/** `worlds.service` 的默认值与界面文案。 */
import { pick, type Language, type LanguageTable } from 'cortico/core/language.ts';
import type { ServiceConfigSection } from './types.ts';

export const SERVICE_ID = 'service';
export const SERVICE_VERSION = '0.9.0';

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
    label: 'Kmch AI · 服务',
    panelServices: '服务',
    panelGateway: '网关',
    lampGateway: '网关',
    lampServices: '服务',
    lampModels: '模型',
  },
  en: {
    label: 'Kmch AI · 服务',
    panelServices: 'Services',
    panelGateway: 'Gateway',
    lampGateway: 'Gateway',
    lampServices: 'Services',
    lampModels: 'Models',
  },
} as const;

export type ServiceText = typeof TEXT.zh;

export function serviceText(language: Language): ServiceText {
  return pick(language, TEXT as unknown as LanguageTable<ServiceText>);
}
