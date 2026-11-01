/** 一种 HTTP 方言要拿到的请求形状;registry 按 `protocolOf(entry)` 选适配器。 */
import type { Logger } from 'cortico/core/types.ts';
import type {
  AudioFormat, ModelProfile, ServiceEntry, TtsAudio, VoiceOption,
} from '../types.ts';

export interface ProtocolRequest {
  entry: ServiceEntry;
  /** 已按模型 profile 拼好的上游请求体。 */
  body: Record<string, unknown>;
  /** 语义字段的原值,给 custom 的字符串模板用。 */
  values: Record<string, string>;
  format: AudioFormat;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch: typeof fetch;
  /** 按 `entry.secretName` 取上游密钥。 */
  secret(name: string): string;
  log?: Logger;
}

export interface VoiceListRequest {
  entry: ServiceEntry;
  model?: string;
  timeoutMs: number;
  fetch: typeof fetch;
  secret(name: string): string;
}

export interface ProtocolAdapter {
  readonly id: ModelProfile['protocol'];
  /** `POST /v1/audio/speech`。 */
  speech(req: ProtocolRequest): Promise<TtsAudio>;
  /** `POST /v1/audio/sing`;只有 sing 适配器实现。 */
  sing?(req: ProtocolRequest): Promise<TtsAudio>;
  /** 上游能列音色时实现;列不到返回空数组。 */
  listVoices?(req: VoiceListRequest): Promise<VoiceOption[]>;
}
