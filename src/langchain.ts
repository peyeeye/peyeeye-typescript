/**
 * LangChain.js integration — redact PII before the model, rehydrate after.
 *
 * ```ts
 * import { ChatOpenAI } from "@langchain/openai";
 * import { Peyeeye } from "peyeeye";
 * import { withPeyeeye } from "peyeeye/langchain";
 *
 * const peyeeye = new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
 * const model   = withPeyeeye(new ChatOpenAI({ model: "gpt-4o-mini" }), { peyeeye });
 *
 * const reply = await model.invoke("Hi, I'm Ada — ada@a-e.com");
 * ```
 *
 * `withPeyeeye` wraps anything with an `.invoke()` (and optionally `.batch()` /
 * `.stream()`) method — LangChain chat models, LLMs, chains, or custom
 * `RunnableLambda`s. Each `invoke` opens a fresh peyeeye session so
 * deterministic tokens hold within one call and never bleed across requests.
 *
 * There is **no hard dependency on LangChain** — the wrapper is a plain
 * object and can be composed into an LCEL chain with
 * `RunnableLambda.from((x) => wrapped.invoke(x))` when you need `.pipe()`.
 */
import type { Peyeeye } from "./client.js";
import type { Shield } from "./shield.js";

export interface WithPeyeeyeOptions {
  /** Configured Peyeeye client. */
  peyeeye: Peyeeye;
  /** Open stateless sealed sessions (no server-side mapping). */
  stateless?: boolean;
  /** Optional error hook for redact/rehydrate failures. */
  onError?: (err: unknown, phase: "redact" | "rehydrate") => void;
}

/** Minimal shape of a LangChain `Runnable` we wrap around. */
interface Invokeable<I = unknown, O = unknown> {
  invoke(input: I, options?: unknown): Promise<O>;
  batch?(inputs: I[], options?: unknown): Promise<O[]>;
  stream?(input: I, options?: unknown): Promise<AsyncIterable<O>>;
}

/**
 * The returned wrapper preserves the inner runnable's `.invoke` signature and
 * forwards `.batch` (one session per item). `.stream` is *not* rehydrated —
 * rehydrating streamed tokens safely requires the partial-token buffer that
 * `shield.rehydrateChunk` provides, which is easier to wire up via the
 * Vercel AI SDK middleware than through LangChain's event stream.
 */
export interface PeyeeyeRunnable<I = unknown, O = unknown> {
  invoke(input: I, options?: unknown): Promise<O>;
  batch(inputs: I[], options?: unknown): Promise<O[]>;
}

export function withPeyeeye<I = unknown, O = unknown>(
  inner: Invokeable<I, O>,
  opts: WithPeyeeyeOptions,
): PeyeeyeRunnable<I, O> {
  const { peyeeye, stateless = false, onError } = opts;

  const open = (): Promise<Shield> => peyeeye.shield({ stateless });

  return {
    async invoke(input: I, options?: unknown): Promise<O> {
      const shield = await open();
      let redacted: I;
      try {
        redacted = (await redactInput(input, shield)) as I;
      } catch (err) {
        onError?.(err, "redact");
        throw err;
      }
      let output: O;
      try {
        output = await inner.invoke(redacted, options);
      } finally {
        // Leave session cleanup to the shield's TTL — LangChain's surface has
        // no hook for post-invoke cleanup of an object we handed back.
      }
      try {
        return (await rehydrateOutput(output, shield)) as O;
      } catch (err) {
        onError?.(err, "rehydrate");
        throw err;
      }
    },

    async batch(inputs: I[], options?: unknown): Promise<O[]> {
      // One session per item keeps tokens from colliding across unrelated
      // prompts in the same batch call.
      return Promise.all(inputs.map((input) => this.invoke(input, options)));
    },
  };
}

// ---------------------------------------------------------------------------
// Redact helpers — handle the handful of shapes LangChain callers use.
// ---------------------------------------------------------------------------

async function redactInput(value: unknown, shield: Shield): Promise<unknown> {
  if (typeof value === "string") {
    return shield.redact(value);
  }
  if (Array.isArray(value)) {
    // Sequential: the shield mints its session on the first redact, and later
    // redacts must reuse it. Running in parallel would fire N concurrent
    // POSTs that each open their own server-side session and tokens would
    // no longer align across messages.
    const out: unknown[] = [];
    for (const m of value) out.push(await redactMessage(m, shield));
    return out;
  }
  if (isTupleMessage(value)) {
    return redactTupleMessage(value, shield);
  }
  if (isRecord(value)) {
    if (hasStringContent(value) || hasContentArray(value)) {
      return redactDictMessage(value, shield);
    }
  }
  const content = readContent(value);
  if (typeof content === "string") {
    return replaceContent(value, await shield.redact(content));
  }
  return value;
}

async function redactMessage(msg: unknown, shield: Shield): Promise<unknown> {
  if (typeof msg === "string") return shield.redact(msg);
  if (isTupleMessage(msg)) return redactTupleMessage(msg, shield);
  if (isRecord(msg) && (hasStringContent(msg) || hasContentArray(msg))) {
    return redactDictMessage(msg, shield);
  }
  const content = readContent(msg);
  if (typeof content === "string") {
    return replaceContent(msg, await shield.redact(content));
  }
  if (Array.isArray(content)) {
    const parts = await redactContentParts(content, shield);
    return replaceContent(msg, parts);
  }
  return msg;
}

async function redactTupleMessage(
  value: readonly [string, string],
  shield: Shield,
): Promise<[string, string]> {
  return [value[0], (await shield.redact(value[1])) as string];
}

async function redactDictMessage(
  value: Record<string, unknown>,
  shield: Shield,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...value };
  const content = out["content"];
  if (typeof content === "string") {
    out["content"] = await shield.redact(content);
  } else if (Array.isArray(content)) {
    out["content"] = await redactContentParts(content, shield);
  }
  return out;
}

async function redactContentParts(parts: unknown[], shield: Shield): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const part of parts) {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
      out.push({ ...part, text: await shield.redact(part["text"] as string) });
    } else {
      out.push(part);
    }
  }
  return out;
}

function replaceContent(message: unknown, newContent: unknown): unknown {
  if (!isRecord(message)) return newContent;
  // BaseMessage-like: prefer `.copy({ content })` (LangChain 0.3+) so the
  // returned value stays a real BaseMessage subclass.
  const copyFn = (message as { copy?: (updates: unknown) => unknown }).copy;
  if (typeof copyFn === "function") {
    try {
      return copyFn.call(message, { content: newContent });
    } catch {
      /* fall through */
    }
  }
  // For duck-typed objects, clone-with-prototype so custom classes keep their
  // shape (e.g. AIMessage → AIMessage), but the `content` field is overridden.
  const proto = Object.getPrototypeOf(message) as object | null;
  const clone = proto ? Object.create(proto) : {};
  Object.assign(clone, message, { content: newContent });
  return clone;
}

// ---------------------------------------------------------------------------
// Rehydrate helpers
// ---------------------------------------------------------------------------

async function rehydrateOutput(value: unknown, shield: Shield): Promise<unknown> {
  if (typeof value === "string") {
    return shield.rehydrate(value);
  }
  const content = readContent(value);
  if (typeof content === "string") {
    return replaceContent(value, await shield.rehydrate(content));
  }
  if (Array.isArray(content)) {
    const parts: unknown[] = [];
    for (const part of content) {
      if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
        parts.push({ ...part, text: await shield.rehydrate(part["text"] as string) });
      } else {
        parts.push(part);
      }
    }
    return replaceContent(value, parts);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tiny type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTupleMessage(v: unknown): v is [string, string] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "string"
  );
}

function hasStringContent(v: Record<string, unknown>): boolean {
  return typeof v["content"] === "string";
}

function hasContentArray(v: Record<string, unknown>): boolean {
  return Array.isArray(v["content"]);
}

function readContent(v: unknown): unknown {
  if (!isRecord(v)) return undefined;
  return v["content"];
}
