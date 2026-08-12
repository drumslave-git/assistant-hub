/**
 * Shared API error shape.
 *
 * Every Route Handler in the app returns errors in this single, consistent
 * envelope. Domain/service code throws `ApiError` (or a subclass); the shared
 * route wrapper maps it to an HTTP response. Do not invent per-feature error
 * shapes — extend the `ApiErrorCode` union instead.
 */

export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "not_implemented"
  | "service_unavailable"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  not_implemented: 501,
  service_unavailable: 503,
  internal_error: 500,
};

/** JSON body returned for any failed request. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Optional machine-readable detail (e.g. Zod issues). Never contains secrets. */
    details?: unknown;
  };
}

/**
 * JSON body returned for any successful request — the other half of the response
 * contract, kept beside {@link ApiErrorBody} because a client that reads one reads
 * the other. The route wrapper in `server/http` is what produces it.
 */
export interface ApiOkBody<T> {
  data: T;
}

/** Options for constructing an {@link ApiError}. */
export interface ApiErrorOptions {
  /** Structured, client-safe detail. */
  details?: unknown;
  /** Underlying error, preserved for server-side logging/traces only. */
  cause?: unknown;
}

/**
 * Error type understood by the shared route wrapper. Throw this from services
 * to control the HTTP status and error code without touching Route Handlers.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
  }

  /** Client-safe JSON body for this error. */
  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static badRequest(message = "Bad request", options?: ApiErrorOptions) {
    return new ApiError("bad_request", message, options);
  }
  static notFound(message = "Not found", options?: ApiErrorOptions) {
    return new ApiError("not_found", message, options);
  }
  static unauthorized(message = "Unauthorized", options?: ApiErrorOptions) {
    return new ApiError("unauthorized", message, options);
  }
  static forbidden(message = "Forbidden", options?: ApiErrorOptions) {
    return new ApiError("forbidden", message, options);
  }
  static conflict(message = "Conflict", options?: ApiErrorOptions) {
    return new ApiError("conflict", message, options);
  }
  static notImplemented(message = "Not implemented", options?: ApiErrorOptions) {
    return new ApiError("not_implemented", message, options);
  }
  static serviceUnavailable(message = "Service unavailable", options?: ApiErrorOptions) {
    return new ApiError("service_unavailable", message, options);
  }
  static internal(message = "Internal server error", options?: ApiErrorOptions) {
    return new ApiError("internal_error", message, options);
  }
}

/** Type guard for {@link ApiError}. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Read the human message out of a failed API response — the client half of the
 * {@link ApiErrorBody} contract. Client-safe; every fetch-and-show-the-error UI
 * uses this instead of keeping its own copy.
 */
export async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export const statusForCode = (code: ApiErrorCode): number => STATUS_BY_CODE[code];
