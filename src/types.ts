/** Public request/response types for the peyeeye API. */

/** BCP-47 language tag or the special value "auto". */
export type Locale = string;

/** A saved policy name, or an inline policy object. */
export type Policy = string | Record<string, unknown>;

/** "stateless" skips server-side storage — response carries a sealed skey_ blob. */
export type SessionRef = string | "stateless";

/** One entity span returned from `/v1/redact`. */
export interface DetectedEntity {
  /** The token inserted in the redacted text, e.g. `[EMAIL_1]`. */
  token: string;
  /** Entity type (PERSON, EMAIL, CARD, …). See the entity catalog. */
  type: string;
  /** `[start, end]` character offsets in the original input. */
  span: [number, number];
  /** Detector confidence 0 … 1. */
  confidence: number;
  /** Original pre-redaction value. May be omitted by the server. */
  value?: string;
}

export interface RedactOptions {
  /** BCP-47 language tag, default "auto". */
  locale?: Locale;
  /** Policy name or inline policy object. */
  policy?: Policy;
  /** Restrict detection to these entity IDs. */
  entities?: string[];
  /** Token template, e.g. "[{TYPE}_{N}]" (default), "<{TYPE}>". */
  placeholder?: string;
  /** Existing session id to extend, or "stateless" for sealed mode. */
  session?: SessionRef;
  /** Passed as the `Idempotency-Key` request header. */
  idempotencyKey?: string;
  /** Abort signal for this request. */
  signal?: AbortSignal;
}

export interface RedactResponse {
  /** Redacted text. Array-in → array-out. */
  redacted: string | string[];
  /** `ses_…` id, or the literal "stateless" when session="stateless". */
  session: string;
  /** Present only in stateless mode — the AES-GCM-sealed mapping (`skey_…`). */
  rehydration_key?: string;
  /** Detected entities with tokens and spans. */
  entities: DetectedEntity[];
  /** Server-side latency in milliseconds. */
  latency_ms: number;
  /** ISO-8601 expiry; only set for stateful sessions. */
  expires_at?: string;
}

export interface RehydrateOptions {
  /** Raise `unknown_token` on unrecognised tokens instead of passing through. */
  strict?: boolean;
  signal?: AbortSignal;
}

export interface RehydrateResponse {
  /** Text with tokens swapped back to their original values. */
  text: string;
  /** How many tokens were replaced. */
  replaced: number;
  /** Tokens that could not be resolved (empty unless strict=false). */
  unknown: string[];
  latency_ms: number;
}

export interface SessionInfo {
  id: string;
  locale: string;
  policy: string;
  chars_processed: number;
  entities_detected: number;
  created_at: string | null;
  expires_at: string | null;
  expired: boolean;
}

export interface BuiltinEntity {
  id: string;
  category: string;
  sample: string;
  locales: string[];
}

export interface CustomDetector {
  id: string;
  kind: "regex" | "fewshot";
  pattern?: string;
  enabled: boolean;
  confidence_floor?: number;
}

export interface EntitiesList {
  builtin: BuiltinEntity[];
  custom: CustomDetector[];
}

export interface EntityTemplate {
  id: string;
  name: string;
  description: string;
  kind: "regex" | "fewshot";
  pattern: string;
  example: string;
  category: string;
}

export interface PatternMatch {
  value: string;
  start: number;
  end: number;
}

export interface TestPatternResponse {
  matches: PatternMatch[];
  count: number;
}

export interface CreateEntityOptions {
  id: string;
  kind?: "regex" | "fewshot";
  pattern?: string;
  examples?: string[];
  confidence_floor?: number;
  signal?: AbortSignal;
}

export interface UpdateEntityOptions {
  pattern?: string;
  enabled?: boolean;
  confidence_floor?: number;
  signal?: AbortSignal;
}

export interface StreamRedactOptions {
  locale?: Locale;
  policy?: Policy;
  signal?: AbortSignal;
}

/** Discriminated union of server-sent events from `/v1/redact/stream`. */
export type StreamEvent =
  | { event: "session"; data: { session: string } }
  | { event: "redacted"; data: { text: string; entities: number } }
  | { event: "done"; data: { chars: number } }
  | { event: string; data: Record<string, unknown> };

/** Rate-limit metadata parsed from response headers. */
export interface RateLimit {
  /** `X-RateLimit-Limit` — sustained RPS for the key. */
  limit: number | null;
  /** `X-RateLimit-Remaining` — remaining budget in the burst bucket. */
  remaining: number | null;
  /** `Retry-After` — seconds to wait (only set on 429). */
  retryAfter: number | null;
}

export interface PeyeeyeOptions {
  /** Bearer key from the dashboard (pk_live_…). Required. */
  apiKey: string;
  /** Override the API host. Defaults to https://api.peyeeye.ai. */
  baseUrl?: string;
  /** Custom fetch implementation (e.g. undici, node-fetch). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Max retries for 429 / 5xx responses. Defaults to 3. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
  /** Extra headers merged onto every request. */
  defaultHeaders?: Record<string, string>;
}
