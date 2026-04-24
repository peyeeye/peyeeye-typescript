import type { RateLimit } from "./types.js";

/**
 * Error thrown for any non-2xx API response or network failure.
 *
 * The shape mirrors the backend error body: `{ code, message, request_id }`
 * plus the HTTP `status` and parsed rate-limit headers.
 */
export class PeyeeyeError extends Error {
  /** Error code from the server, e.g. "rate_limited", "invalid_request". */
  readonly code: string;
  /** HTTP status code. `0` for network / transport errors. */
  readonly status: number;
  /** `request_id` from the response body, if present. */
  readonly requestId?: string;
  /** Parsed rate-limit headers, if the response carried any. */
  readonly rateLimit?: RateLimit;

  constructor(opts: {
    code: string;
    status: number;
    message: string;
    requestId?: string;
    rateLimit?: RateLimit;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "PeyeeyeError";
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.rateLimit = opts.rateLimit;
  }

  /** True for transient errors that the SDK will retry. */
  get retryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status < 600);
  }
}
