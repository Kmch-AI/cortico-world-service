/** 协议适配器登记表:按 `ServiceEntry.protocol` 选方言。 */
import { ServiceError } from '../errors.ts';
import type { ServiceEntry, ServiceProtocol } from '../types.ts';
import { audiocppProtocol } from './audiocpp.ts';
import { customProtocol } from './custom.ts';
import { openaiProtocol } from './openai.ts';
import { singProtocol } from './sing.ts';
import type { ProtocolAdapter } from './types.ts';

const ADAPTERS: Readonly<Record<Exclude<ServiceProtocol, 'none'>, ProtocolAdapter>> = {
  audiocpp: audiocppProtocol,
  openai: openaiProtocol,
  custom: customProtocol,
  sing: singProtocol,
};

export function protocolOf(entry: ServiceEntry): ProtocolAdapter {
  if (entry.protocol === 'none') {
    throw ServiceError.unavailable(`service ${entry.id} has no HTTP protocol`);
  }
  return ADAPTERS[entry.protocol];
}

/** 能接 `/v1/audio/speech` 的条目。 */
export function acceptsSpeech(entry: ServiceEntry): boolean {
  return entry.protocol === 'openai' || entry.protocol === 'audiocpp' || entry.protocol === 'custom';
}

/** 能接 `/v1/audio/sing` 的条目。 */
export function acceptsSing(entry: ServiceEntry): boolean {
  return entry.protocol === 'sing';
}

export { audiocppProtocol, customProtocol, openaiProtocol, singProtocol };
export type { ProtocolAdapter, ProtocolRequest, VoiceListRequest } from './types.ts';
