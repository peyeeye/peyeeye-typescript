import type { Peyeeye } from "./client.js";
import type { RedactOptions } from "./types.js";

/**
 * Matches an unterminated token at the tail of a buffer — e.g. `"...[EMA"`
 * or `"...[EMAIL_1"` without its closing `]`. We hold those back so we
 * never emit a half-formed placeholder to the end user.
 */
const PARTIAL_TOKEN_TAIL = /\[[A-Z_0-9]*$/;

/**
 * Session-scoped helper returned from `peyeeye.shield()`.
 *
 * Carries the session id across calls so `Ada Lovelace` resolves to the
 * same `[PERSON_1]` token on every redact. Supports partial-token-safe
 * streaming rehydration via `rehydrateChunk()` + `flush()`.
 */
export class Shield {
  /** `ses_…` id for stateful mode, or empty string before the first redact. */
  sessionId = "";
  /** `skey_…` sealed blob in stateless mode. */
  rehydrationKey: string | undefined;
  /** The most recent redacted result (string or array). */
  lastRedacted: string | string[] | null = null;

  private readonly _client: Peyeeye;
  private readonly _opts: RedactOptions;
  private readonly _stateless: boolean;
  private _buf = "";

  constructor(client: Peyeeye, opts: RedactOptions) {
    this._client = client;
    this._opts = opts;
    this._stateless = opts.session === "stateless";
  }

  /**
   * Redact `text` inside this shield's session.
   *
   * First call establishes the session; subsequent calls reuse it so repeated
   * real values always yield the same token.
   */
  async redact(text: string): Promise<string>;
  async redact(text: string[]): Promise<string[]>;
  async redact(text: string | string[]): Promise<string | string[]> {
    const opts: RedactOptions = { ...this._opts };
    if (this.sessionId) opts.session = this.sessionId;
    const r = await this._client.redact(text as string, opts);
    if (!this.sessionId && !this._stateless) this.sessionId = r.session;
    if (r.rehydration_key) this.rehydrationKey = r.rehydration_key;
    this.lastRedacted = r.redacted;
    return r.redacted;
  }

  /**
   * Swap tokens in `text` back to their original values using this session's
   * mapping.
   */
  async rehydrate(text: string, opts: { strict?: boolean } = {}): Promise<string> {
    const session = this.rehydrationKey ?? this.sessionId;
    if (!session) {
      throw new Error(
        "Shield.rehydrate: no session — call shield.redact() at least once first.",
      );
    }
    const r = await this._client.rehydrate(text, session, { strict: opts.strict });
    return r.text;
  }

  /**
   * Streaming-safe rehydrate. Buffers a partial token at the tail of `chunk`
   * until the next call completes it, so users never see half-rendered
   * placeholders.
   *
   * Call once per upstream LLM chunk, then `flush()` after the stream closes.
   * Calling `flush()` mid-stream can emit a partial token.
   */
  async rehydrateChunk(chunk: string): Promise<string> {
    this._buf += chunk;
    const match = PARTIAL_TOKEN_TAIL.exec(this._buf);
    let safe: string;
    if (match) {
      safe = this._buf.slice(0, match.index);
      this._buf = this._buf.slice(match.index);
    } else {
      safe = this._buf;
      this._buf = "";
    }
    if (!safe) return "";
    return this.rehydrate(safe);
  }

  /** Emit anything still buffered by `rehydrateChunk`. Call once upstream closes. */
  async flush(): Promise<string> {
    const remainder = this._buf;
    this._buf = "";
    if (!remainder) return "";
    return this.rehydrate(remainder);
  }

  /**
   * Drop the session on the server immediately. Safe to call even if the
   * session has already expired. No-op in stateless mode.
   */
  async destroy(): Promise<void> {
    if (this._stateless || !this.sessionId) return;
    try {
      await this._client.deleteSession(this.sessionId);
    } catch {
      // Expired sessions 404 — ignore.
    } finally {
      this.sessionId = "";
      this.rehydrationKey = undefined;
    }
  }
}
