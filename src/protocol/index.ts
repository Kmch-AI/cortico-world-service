/** 协议适配器登记表:按 `protocolOf(entry)` 选方言。 */
import { protocolOf } from '../entry.ts';
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

export function adapterOf(entry: ServiceEntry): ProtocolAdapter {
  const protocol = protocolOf(entry);
  if (protocol === 'none') {
    throw ServiceError.unavailable(`service ${entry.id} has no HTTP protocol`);
  }
  return ADAPTERS[protocol];
}

/** 能接 `/v1/audio/speech` 的条目。 */
export function acceptsSpeech(entry: ServiceEntry): boolean {
  const protocol = protocolOf(entry);
  return protocol === 'openai' || protocol === 'audiocpp' || protocol === 'custom';
}

/** 能接 `/v1/audio/sing` 的条目。 */
export function acceptsSing(entry: ServiceEntry): boolean {
  return protocolOf(entry) === 'sing';
}

export { audiocppProtocol, customProtocol, openaiProtocol, protocolOf, singProtocol };
export type { ProtocolAdapter, ProtocolRequest, VoiceListRequest } from './types.ts';
