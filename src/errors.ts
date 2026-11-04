/**
 * 服务内部的错误类型:网关把它映射成设计里的状态码与
 * `{error:{message,type,code,param}}`;协议层用 `upstream` / `timeout` 区分上游失败与超时。
 */

export type ServiceErrorKind =
  | 'invalid'
  | 'auth'
  | 'notfound'
  | 'too_large'
  | 'rate'
  | 'unsupported'
  | 'upstream'
  | 'unavailable'
  | 'timeout';

interface ErrorShape {
  status: number;
  type: string;
  code: string;
}

const SHAPES: Readonly<Record<ServiceErrorKind, ErrorShape>> = {
  invalid: { status: 400, type: 'invalid_request_error', code: 'invalid_request' },
  auth: { status: 401, type: 'authentication_error', code: 'invalid_token' },
  notfound: { status: 404, type: 'not_found_error', code: 'not_found' },
  too_large: { status: 413, type: 'invalid_request_error', code: 'request_too_large' },
  rate: { status: 429, type: 'rate_limit_error', code: 'queue_full' },
  unsupported: { status: 501, type: 'invalid_request_error', code: 'unsupported' },
  upstream: { status: 502, type: 'upstream_error', code: 'upstream_failed' },
  unavailable: { status: 503, type: 'service_unavailable', code: 'not_ready' },
  timeout: { status: 504, type: 'timeout_error', code: 'timeout' },
};

export interface ServiceErrorOptions {
  /** 出错字段,写进 JSON 的 `param`。 */
  param?: string;
  /** 覆盖默认 code(状态与 type 仍按 kind)。 */
  code?: string;
  cause?: unknown;
}

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;
  /** 503 带 `Retry-After`;单位秒。 */
  readonly retryAfterSec: number | null;

  constructor(kind: ServiceErrorKind, message: string, opts: ServiceErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ServiceError';
    this.kind = kind;
    const shape = SHAPES[kind];
    this.status = shape.status;
    this.type = shape.type;
    this.code = opts.code ?? shape.code;
    this.param = opts.param ?? null;
    this.retryAfterSec = kind === 'unavailable' ? 2 : null;
  }

  static invalid(message: string, param?: string): ServiceError {
    return new ServiceError('invalid', message, { param });
  }

  static auth(message = 'invalid token'): ServiceError {
    return new ServiceError('auth', message);
  }

  static notfound(message: string, param?: string): ServiceError {
    return new ServiceError('notfound', message, { param });
  }

  static tooLarge(message: string): ServiceError {
    return new ServiceError('too_large', message);
  }

  static unsupported(message: string): ServiceError {
    return new ServiceError('unsupported', message);
  }

  static upstream(message: string, cause?: unknown): ServiceError {
    return new ServiceError('upstream', message, { cause });
  }

  static unavailable(message: string): ServiceError {
    return new ServiceError('unavailable', message);
  }

  static timeout(message: string): ServiceError {
    return new ServiceError('timeout', message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
