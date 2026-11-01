/**
 * 服务网关:只监听配置里的地址,把五条固定路由暴露给语音 World 与其他本机客户端。
 * 解析、鉴权、限额与错误映射都在这里;合成与模型目录由 World 通过 handlers 提供。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'cortico/core/types.ts';
import { ServiceError, errorMessage } from '../errors.ts';
import type {
  AudioFormat, GatewayPhase, ServiceConfigSection, ServiceStatus, SingRequest,
  SpeechRequest, TtsAudio,
} from '../types.ts';

const BODY_MAX = 1024 * 1024;
const INPUT_MAX = 8000;
const INSTRUCTIONS_MAX = 2000;
const OPTIONS_MAX = 16 * 1024;
const VOICE_MAX = 200;
const EMOTION_MAX = 200;
const LANGUAGE_MAX = 64;
const MODEL_MAX = 200;

export interface GatewayHealthBody {
  status: GatewayPhase;
  ready: boolean;
  version: string;
  uptimeSec: number;
  services: ServiceStatus[];
  models: number;
}

export interface GatewayModel {
  id: string;
  object: 'model';
  owned_by: string;
  service: string;
  display_name?: string;
  tasks?: string[];
  voices?: string[];
}

export interface GatewayVoiceQuery {
  model?: string;
  service?: string;
}

export interface GatewayVoice {
  id: string;
  value: string;
  label: string;
  model: string;
  service: string;
}

export interface GatewayVoiceList {
  model: string;
  voices: string[];
  data: GatewayVoice[];
}

export interface GatewayHandlers {
  health(): GatewayHealthBody | Promise<GatewayHealthBody>;
  models(): GatewayModel[] | Promise<GatewayModel[]>;
  voices(query: GatewayVoiceQuery): GatewayVoiceList | Promise<GatewayVoiceList>;
  speech(request: SpeechRequest, signal: AbortSignal): Promise<TtsAudio>;
  sing(request: SingRequest, signal: AbortSignal): Promise<TtsAudio>;
}

export interface GatewayOptions {
  host: string;
  port: number;
  /** 解析后的令牌值;空表示回环免认证。 */
  token: string;
  /** token 非空或配置要求时,没有正确令牌一律 401。 */
  tokenRequired: boolean;
  allowQueryToken: boolean;
  handlers: GatewayHandlers;
  log: Logger;
}

export interface GatewayHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

/** 完整的 127/8 点分四段地址;`127.example.com` 这类主机名不算。 */
function isIPv4Loopback(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    if (number > 255) return false;
    if (index === 0 && number !== 127) return false;
  }
  return true;
}

/** 回环地址才允许无令牌启动。主机名一律按非回环处理,除非正好是 localhost。 */
export function isLoopbackHost(host: string | undefined): boolean {
  const raw = (host ?? '').trim().toLowerCase();
  const value = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!value) return true;
  return value === 'localhost'
    || value === '::1'
    || value === '0:0:0:0:0:0:0:1'
    || isIPv4Loopback(value);
}

/**
 * 校验令牌配置:非回环地址必须配令牌;令牌变量名存在但值为空同样拒绝。
 * 返回 null 表示可以启动。
 */
export function gatewayAuthError(cfg: Pick<ServiceConfigSection, 'host' | 'tokenSecret'>, token: string): string | null {
  const name = cfg.tokenSecret.trim();
  const value = token.trim();
  if (name && !value) return `token variable ${name} is empty`;
  if (!value && !isLoopbackHost(cfg.host)) {
    return `non-loopback host ${cfg.host.trim() || '(empty)'} requires tokenSecret`;
  }
  return null;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > BODY_MAX) {
      reject(new ServiceError('too_large', `request body must be at most ${BODY_MAX} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_MAX) {
        settle(() => reject(new ServiceError('too_large', `request body must be at most ${BODY_MAX} bytes`)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      settle(() => {
        if (!chunks.length) { resolve({}); return; }
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(ServiceError.invalid('body is not valid JSON'));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(ServiceError.invalid('body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      });
    });
    req.on('error', () => {
      settle(() => reject(ServiceError.invalid('request body could not be read')));
    });
  });
}

function textField(value: unknown, name: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw ServiceError.invalid(`${name} is required`, name);
    return undefined;
  }
  if (typeof value !== 'string') throw ServiceError.invalid(`${name} must be a string`, name);
  const text = value.trim();
  if (!text) {
    if (required) throw ServiceError.invalid(`${name} is required`, name);
    return undefined;
  }
  if ([...text].length > max) {
    throw ServiceError.invalid(`${name} must be at most ${max} characters`, name);
  }
  return text;
}

function numberField(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) {
    throw ServiceError.invalid(`${name} must be a positive number`, name);
  }
  return number;
}

function formatField(value: unknown): AudioFormat {
  if (value === undefined || value === null || value === '') return 'wav';
  if (value === 'wav' || value === 'mp3') return value;
  throw ServiceError.invalid("response_format must be 'wav' or 'mp3'", 'response_format');
}

function optionsField(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ServiceError.invalid('options must be a JSON object', 'options');
  }
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > OPTIONS_MAX) {
    throw new ServiceError('too_large', `options must be at most ${OPTIONS_MAX} bytes`, { param: 'options' });
  }
  return value as Record<string, unknown>;
}

function rejectPlay(body: Record<string, unknown>): void {
  if (body.play === undefined || body.play === false || body.play === null) return;
  throw ServiceError.invalid('play is not supported; playback belongs to the voice World', 'play');
}

function speechRequestOf(body: Record<string, unknown>): SpeechRequest {
  rejectPlay(body);
  const request: SpeechRequest = {
    input: textField(body.input, 'input', INPUT_MAX, true)!,
    format: formatField(body.response_format),
  };
  const model = textField(body.model, 'model', MODEL_MAX, false);
  const voice = textField(body.voice, 'voice', VOICE_MAX, false);
  const instructions = textField(body.instructions, 'instructions', INSTRUCTIONS_MAX, false);
  const emotion = textField(body.emotion, 'emotion', EMOTION_MAX, false);
  const language = textField(body.language, 'language', LANGUAGE_MAX, false);
  const speed = numberField(body.speed, 'speed');
  const options = optionsField(body.options);
  if (model) request.model = model;
  if (voice) request.voice = voice;
  if (instructions) request.instructions = instructions;
  if (emotion) request.emotion = emotion;
  if (language) request.language = language;
  if (speed !== undefined) request.speed = speed;
  if (options) request.options = options;
  return request;
}

function singRequestOf(body: Record<string, unknown>): SingRequest {
  rejectPlay(body);
  const request: SingRequest = {
    lyrics: textField(body.lyrics, 'lyrics', INPUT_MAX, true)!,
  };
  const model = textField(body.model, 'model', MODEL_MAX, false);
  if (model) request.model = model;
  return request;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function writeAudio(res: ServerResponse, audio: TtsAudio): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, {
    'content-type': audio.mime,
    'content-length': audio.bytes.length,
    'cache-control': 'no-store',
    ...(audio.seconds !== undefined ? { 'x-voice-seconds': audio.seconds.toFixed(2) } : {}),
  });
  res.end(Buffer.from(audio.bytes));
}

function writeError(res: ServerResponse, error: unknown, log: Logger): void {
  if (res.destroyed || res.writableEnded) return;
  const serviceError = error instanceof ServiceError
    ? error
    : ServiceError.upstream(`request failed: ${errorMessage(error)}`);
  if (serviceError.kind !== 'invalid' && serviceError.kind !== 'notfound' && serviceError.kind !== 'auth') {
    log.warn('服务网关请求失败', {
      status: serviceError.status,
      code: serviceError.code,
      err: serviceError.message,
    });
  }
  const text = JSON.stringify({
    error: {
      message: serviceError.message,
      type: serviceError.type,
      code: serviceError.code,
      param: serviceError.param,
    },
  });
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  };
  if (serviceError.retryAfterSec !== null) headers['retry-after'] = serviceError.retryAfterSec;
  if (serviceError.status === 413) headers.connection = 'close';
  res.writeHead(serviceError.status, headers);
  res.end(text);
}

function normalizePath(pathname: string): string {
  if (pathname.length <= 1) return pathname;
  return pathname.replace(/\/+$/, '');
}

export function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const token = opts.token.trim();
  if (opts.tokenRequired && !token) {
    return Promise.reject(new Error('gateway token is required'));
  }

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && match[1] === token) return true;
    return opts.allowQueryToken && url.searchParams.get('token') === token;
  };

  const run = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const method = req.method ?? 'GET';
    const path = normalizePath(url.pathname);

    if (!authorized(req, url)) throw ServiceError.auth('invalid token');

    if (method === 'GET' && path === '/health') {
      writeJson(res, 200, await opts.handlers.health());
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      writeJson(res, 200, { object: 'list', data: await opts.handlers.models() });
      return;
    }
    if (method === 'GET' && path === '/v1/audio/voices') {
      const model = url.searchParams.get('model')?.trim() || undefined;
      const service = url.searchParams.get('service')?.trim() || undefined;
      const list = await opts.handlers.voices({
        ...(model ? { model } : {}),
        ...(service ? { service } : {}),
      });
      writeJson(res, 200, {
        object: 'list',
        model: list.model,
        voices: list.voices,
        data: list.data,
      });
      return;
    }
    if (method === 'POST' && path === '/v1/audio/speech') {
      const request = speechRequestOf(await readJson(req));
      const ctrl = new AbortController();
      const onClose = (): void => { if (!res.writableFinished) ctrl.abort(new Error('client disconnected')); };
      res.on('close', onClose);
      try {
        writeAudio(res, await opts.handlers.speech(request, ctrl.signal));
      } finally {
        res.off('close', onClose);
      }
      return;
    }
    if (method === 'POST' && path === '/v1/audio/sing') {
      const request = singRequestOf(await readJson(req));
      const ctrl = new AbortController();
      const onClose = (): void => { if (!res.writableFinished) ctrl.abort(new Error('client disconnected')); };
      res.on('close', onClose);
      try {
        writeAudio(res, await opts.handlers.sing(request, ctrl.signal));
      } finally {
        res.off('close', onClose);
      }
      return;
    }
    throw ServiceError.notfound(`no such route: ${method} ${url.pathname}`);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void run(req, res).catch((error: unknown) => {
      writeError(res, error, opts.log);
    });
  };

  return new Promise<GatewayHandle>((resolve, reject) => {
    let server: Server;
    try {
      server = createServer(handler);
    } catch (error) {
      reject(error);
      return;
    }
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      server.on('error', (error) => {
        opts.log.warn('服务网关错误', { err: errorMessage(error) });
      });
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : opts.port;
      resolve({
        host: opts.host,
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
