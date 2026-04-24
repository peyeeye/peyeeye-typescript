import { PeyeeyeError } from "./errors.js";
import { parseSSE } from "./sse.js";
import { Shield } from "./shield.js";
import type {
  CreateEntityOptions,
  CustomDetector,
  EntitiesList,
  EntityTemplate,
  PeyeeyeOptions,
  RateLimit,
  RedactOptions,
  RedactResponse,
  RehydrateOptions,
  RehydrateResponse,
  SessionInfo,
  StreamEvent,
  StreamRedactOptions,
  TestPatternResponse,
  UpdateEntityOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.peyeeye.ai";
const SDK_VERSION = "1.0.0";
const USER_AGENT = `peyeeye-js/${SDK_VERSION}`;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** One public entrypoint. Construct once and reuse. */
export class Peyeeye {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _defaultHeaders: Record<string, string>;

  constructor(opts: PeyeeyeOptions) {
    if (!opts || !opts.apiKey) {
      throw new TypeError("Peyeeye: `apiKey` is required.");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const rawFetch = opts.fetch ?? globalThis.fetch;
    if (typeof rawFetch !== "function") {
      throw new TypeError(
        "Peyeeye: no global `fetch` available. Pass `fetch` in options or use Node 18+.",
      );
    }
    // Bind so native fetch doesn't lose `this` when invoked.
    this._fetch = rawFetch.bind(globalThis) as typeof globalThis.fetch;
    this._defaultHeaders = { ...(opts.defaultHeaders ?? {}) };
  }

  // ---------------------------------------------------------------- redact

  /**
   * Detect PII and replace each span with a deterministic token.
   *
   * `text` may be a string or an array — arrays are redacted in the same
   * session (so `Ada Lovelace` is always `[PERSON_1]` across elements) and
   * the response `redacted` mirrors the input shape.
   *
   * Pass `session: "stateless"` to skip server-side storage; the response
   * will include a `rehydration_key` (`skey_…`) that you hand back to
   * `/rehydrate` yourself.
   */
  async redact(text: string | string[], opts: RedactOptions = {}): Promise<RedactResponse> {
    const body: Record<string, unknown> = { text };
    if (opts.locale !== undefined) body.locale = opts.locale;
    if (opts.policy !== undefined) body.policy = opts.policy;
    if (opts.entities !== undefined) body.entities = opts.entities;
    if (opts.placeholder !== undefined) body.placeholder = opts.placeholder;
    if (opts.session !== undefined) body.session = opts.session;
    const { data } = await this._request<RedactResponse>("POST", "/v1/redact", {
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return data;
  }

  /**
   * Swap tokens in `text` back to their original values.
   *
   * `session` may be either a `ses_…` id returned from `redact()`, or a
   * stateless `skey_…` rehydration key.
   */
  async rehydrate(
    text: string,
    session: string,
    opts: RehydrateOptions = {},
  ): Promise<RehydrateResponse> {
    const body = { text, session, strict: !!opts.strict };
    const { data } = await this._request<RehydrateResponse>("POST", "/v1/rehydrate", {
      body,
      signal: opts.signal,
    });
    return data;
  }

  // --------------------------------------------------------------- streaming

  /**
   * Stream-redact an iterable of chunks over SSE.
   *
   * Returns an async iterable you can `for await … of` — yields one
   * `StreamEvent` per server-sent event. The first yielded event is always
   * `session`; subsequent events are `redacted` (per chunk) and finally
   * `done`. Requires the Build plan or higher.
   */
  redactStream(
    chunks: string[] | Iterable<string>,
    opts: StreamRedactOptions = {},
  ): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      chunks: Array.from(chunks as Iterable<string>),
    };
    if (opts.locale !== undefined) body.locale = opts.locale;
    if (opts.policy !== undefined) body.policy = opts.policy;
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        yield* self._streamRequest("/v1/redact/stream", body, opts.signal);
      },
    };
  }

  // ---------------------------------------------------------------- sessions

  /** `GET /v1/sessions/:id` — inspect a stateful session. */
  async getSession(sessionId: string, opts: { signal?: AbortSignal } = {}): Promise<SessionInfo> {
    const { data } = await this._request<SessionInfo>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { signal: opts.signal },
    );
    return data;
  }

  /** `DELETE /v1/sessions/:id` — drop a session immediately. */
  async deleteSession(sessionId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this._request<void>("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      signal: opts.signal,
      expectEmpty: true,
    });
  }

  // -------------------------------------------------------------- detectors

  /** `GET /v1/entities` — builtin catalog + org custom detectors. */
  async listEntities(opts: { signal?: AbortSignal } = {}): Promise<EntitiesList> {
    const { data } = await this._request<EntitiesList>("GET", "/v1/entities", {
      signal: opts.signal,
    });
    return data;
  }

  /**
   * `POST /v1/entities` — create or upsert a custom detector.
   *
   * Plan-gated: Free allows 0, Build 3, Pro 10, Scale unlimited.
   * Over-cap returns 403 `forbidden`.
   */
  async createEntity(opts: CreateEntityOptions): Promise<CustomDetector> {
    const body: Record<string, unknown> = { id: opts.id, kind: opts.kind ?? "regex" };
    if (opts.pattern !== undefined) body.pattern = opts.pattern;
    if (opts.examples !== undefined) body.examples = opts.examples;
    if (opts.confidence_floor !== undefined) body.confidence_floor = opts.confidence_floor;
    const { data } = await this._request<CustomDetector>("POST", "/v1/entities", {
      body,
      signal: opts.signal,
    });
    return data;
  }

  /** `PATCH /v1/entities/:id` — partial-update a detector. */
  async updateEntity(entityId: string, opts: UpdateEntityOptions): Promise<CustomDetector> {
    const body: Record<string, unknown> = {};
    if (opts.pattern !== undefined) body.pattern = opts.pattern;
    if (opts.enabled !== undefined) body.enabled = opts.enabled;
    if (opts.confidence_floor !== undefined) body.confidence_floor = opts.confidence_floor;
    const { data } = await this._request<CustomDetector>(
      "PATCH",
      `/v1/entities/${encodeURIComponent(entityId)}`,
      { body, signal: opts.signal },
    );
    return data;
  }

  /** `DELETE /v1/entities/:id` — retire a custom detector. */
  async deleteEntity(entityId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this._request<void>("DELETE", `/v1/entities/${encodeURIComponent(entityId)}`, {
      signal: opts.signal,
      expectEmpty: true,
    });
  }

  /** `POST /v1/entities/test` — dry-run a regex against sample text. */
  async testPattern(
    args: { pattern: string; text: string; signal?: AbortSignal },
  ): Promise<TestPatternResponse> {
    const { data } = await this._request<TestPatternResponse>("POST", "/v1/entities/test", {
      body: { pattern: args.pattern, text: args.text },
      signal: args.signal,
    });
    return data;
  }

  /** `GET /v1/entities/templates` — starter detector templates. */
  async entityTemplates(opts: { signal?: AbortSignal } = {}): Promise<EntityTemplate[]> {
    const { data } = await this._request<{ templates: EntityTemplate[] }>(
      "GET",
      "/v1/entities/templates",
      { signal: opts.signal },
    );
    return data.templates ?? [];
  }

  // ----------------------------------------------------------------- shield

  /**
   * Create a shield — a session-scoped helper that auto-carries the session
   * id across `redact()` / `rehydrate()` calls.
   *
   * ```ts
   * const shield = await peyeeye.shield();
   * const safe  = await shield.redact("Hi, I'm Ada, ada@a-e.com");
   * const back  = await shield.rehydrate(modelReply);
   * ```
   *
   * Pass `{ stateless: true }` for sealed-blob mode — the shield will hold the
   * `skey_…` key itself and use it on rehydrate.
   */
  async shield(
    opts: Omit<RedactOptions, "session" | "idempotencyKey"> & { stateless?: boolean } = {},
  ): Promise<Shield> {
    const { stateless, ...rest } = opts;
    const redactOpts: RedactOptions = { ...rest };
    if (stateless) redactOpts.session = "stateless";
    return new Shield(this, redactOpts);
  }

  // ------------------------------------------------------------------ http

  private async *_streamRequest(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, void> {
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders({
      "Content-Type": "application/json",
      Accept: "*/*",
    });
    const res = await this._fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body) {
      throw new PeyeeyeError({
        code: "transport_error",
        status: 0,
        message: "Streaming response has no body.",
      });
    }
    for await (const evt of parseSSE(res.body)) {
      yield evt;
    }
  }

  private _buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...this._defaultHeaders,
      ...extra,
    };
  }

  private async _request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
      expectEmpty?: boolean;
    } = {},
  ): Promise<{ data: T; rateLimit: RateLimit }> {
    const url = `${this.baseUrl}${path}`;
    const headers = this._buildHeaders(
      opts.body !== undefined ? { "Content-Type": "application/json" } : {},
    );
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const payload =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    let attempt = 0;
    let lastError: PeyeeyeError | null = null;
    for (;;) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(opts.signal?.reason);
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timeout =
        this.timeoutMs > 0
          ? setTimeout(() => controller.abort(new Error("Timeout")), this.timeoutMs)
          : null;

      let res: Response;
      try {
        res = await this._fetch(url, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) {
          throw new PeyeeyeError({
            code: "aborted",
            status: 0,
            message: "Request aborted.",
            cause: err,
          });
        }
        if (attempt < this.maxRetries) {
          await backoff(attempt, null);
          attempt++;
          lastError = new PeyeeyeError({
            code: "network_error",
            status: 0,
            message: (err as Error).message || "Network error",
            cause: err,
          });
          continue;
        }
        throw new PeyeeyeError({
          code: "network_error",
          status: 0,
          message: (err as Error).message || "Network error",
          cause: err,
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onAbort);
      }

      const rateLimit = parseRateLimit(res.headers);

      if (res.ok) {
        if (opts.expectEmpty || res.status === 204) {
          return { data: undefined as unknown as T, rateLimit };
        }
        const ctype = res.headers.get("content-type") ?? "";
        if (!ctype.includes("application/json")) {
          return { data: undefined as unknown as T, rateLimit };
        }
        const text = await res.text();
        const data = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
        return { data, rateLimit };
      }

      if (RETRYABLE_STATUSES.has(res.status) && attempt < this.maxRetries) {
        await backoff(attempt, res.headers.get("retry-after"));
        attempt++;
        lastError = await errorFromResponse(res);
        continue;
      }

      throw await errorFromResponse(res);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void lastError;
  }
}

// ---------------------------------------------------------------- helpers

function parseRateLimit(headers: Headers): RateLimit {
  const toNum = (v: string | null): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: toNum(headers.get("x-ratelimit-limit")),
    remaining: toNum(headers.get("x-ratelimit-remaining")),
    retryAfter: toNum(headers.get("retry-after")),
  };
}

async function errorFromResponse(res: Response): Promise<PeyeeyeError> {
  let body: Record<string, unknown> = {};
  try {
    const text = await res.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const rateLimit = parseRateLimit(res.headers);
  const code = typeof body.code === "string" ? body.code : defaultCode(res.status);
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.detail === "string"
        ? body.detail
        : res.statusText || "Error";
  const requestId =
    (typeof body.request_id === "string" ? body.request_id : undefined) ??
    res.headers.get("x-request-id") ??
    undefined;
  return new PeyeeyeError({ code, status: res.status, message, requestId, rateLimit });
}

function defaultCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "idempotency_conflict";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return "invalid_request";
}

async function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  let delay: number | null = null;
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed)) delay = Math.max(0, parsed * 1000);
  }
  if (delay === null) {
    const base = 250 * 2 ** attempt;
    delay = Math.min(15_000, base + Math.random() * base * 0.1);
  }
  await new Promise((r) => setTimeout(r, Math.min(15_000, delay!)));
}
