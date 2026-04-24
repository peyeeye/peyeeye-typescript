/**
 * Vercel AI SDK middleware — redact PII out of prompts before they hit the
 * model and rehydrate tokens in the response.
 *
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { Peyeeye } from "peyeeye";
 * import { peyeeyeMiddleware } from "peyeeye/vercel-ai";
 *
 * const peyeeye = new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
 *
 * const model = wrapLanguageModel({
 *   model: openai("gpt-4o-mini"),
 *   middleware: peyeeyeMiddleware({ peyeeye }),
 * });
 * ```
 *
 * The middleware scopes one peyeeye session per model call — deterministic
 * tokens within a single generation, no cross-request leakage. Tool call /
 * result content is passed through untouched; only user-visible text is
 * transformed.
 */

import type { Peyeeye } from "./client.js";
import type { Shield } from "./shield.js";

/** Minimal subset of `LanguageModelV1TextPart` (from the `ai` package). */
interface TextPart {
  type: "text";
  text: string;
}

/** Any other prompt part (image, tool-call, tool-result, …) is passed through. */
interface OpaquePart {
  type: string;
  [k: string]: unknown;
}

type PromptPart = TextPart | OpaquePart;

interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | PromptPart[];
  [k: string]: unknown;
}

/** The subset of `LanguageModelV1CallOptions` we need to touch. */
export interface Params {
  prompt: PromptMessage[];
  [k: string]: unknown;
}

/** The shape `doGenerate()` resolves to — only `.text` is redaction-relevant. */
export interface GenerateResult {
  text?: string;
  [k: string]: unknown;
}

/** A text-delta event from a streamed generation. */
interface TextDeltaPart {
  type: "text-delta";
  textDelta: string;
}

interface OpaqueStreamPart {
  type: string;
  [k: string]: unknown;
}

type StreamPart = TextDeltaPart | OpaqueStreamPart;

export interface StreamResult {
  stream: ReadableStream<StreamPart>;
  [k: string]: unknown;
}

/** The middleware shape Vercel AI SDK expects from `LanguageModelV1Middleware`. */
export interface PeyeeyeMiddleware {
  transformParams(opts: {
    type: "generate" | "stream";
    params: Params;
  }): Promise<Params>;
  wrapGenerate(opts: {
    doGenerate: () => Promise<GenerateResult>;
    params: Params;
  }): Promise<GenerateResult>;
  wrapStream(opts: {
    doStream: () => Promise<StreamResult>;
    params: Params;
  }): Promise<StreamResult>;
}

export interface PeyeeyeMiddlewareOptions {
  peyeeye: Peyeeye;
  /** Open the shield in stateless (sealed) mode — no mapping is stored server-side. */
  stateless?: boolean;
  /** Called if the middleware can't reach peyeeye. Default: rethrow. */
  onError?: (err: unknown) => void;
}

export function peyeeyeMiddleware(
  opts: PeyeeyeMiddlewareOptions,
): PeyeeyeMiddleware {
  const { peyeeye, stateless } = opts;
  const shields = new WeakMap<Params, Shield>();

  const handle = (err: unknown): never => {
    if (opts.onError) {
      opts.onError(err);
      throw err;
    }
    throw err;
  };

  return {
    async transformParams({ params }) {
      try {
        const shield = await peyeeye.shield(
          stateless ? { stateless: true } : undefined,
        );
        const redacted = await redactPrompt(params.prompt, shield);
        const newParams: Params = { ...params, prompt: redacted };
        shields.set(newParams, shield);
        return newParams;
      } catch (err) {
        return handle(err);
      }
    },

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const shield = shields.get(params);
      if (!shield) return result;
      if (typeof result.text === "string" && result.text.length > 0) {
        result.text = await shield.rehydrate(result.text);
      }
      return result;
    },

    async wrapStream({ doStream, params }) {
      const result = await doStream();
      const shield = shields.get(params);
      if (!shield) return result;
      return { ...result, stream: rehydrateStream(result.stream, shield) };
    },
  };
}

async function redactPrompt(
  prompt: PromptMessage[],
  shield: Shield,
): Promise<PromptMessage[]> {
  const out: PromptMessage[] = [];
  for (const msg of prompt) {
    out.push(await redactMessage(msg, shield));
  }
  return out;
}

async function redactMessage(
  msg: PromptMessage,
  shield: Shield,
): Promise<PromptMessage> {
  if (typeof msg.content === "string") {
    if (msg.content.length === 0) return msg;
    return { ...msg, content: await shield.redact(msg.content) };
  }
  const parts: PromptPart[] = [];
  for (const part of msg.content) {
    if (isTextPart(part) && part.text.length > 0) {
      parts.push({ ...part, text: await shield.redact(part.text) });
    } else {
      parts.push(part);
    }
  }
  return { ...msg, content: parts };
}

function isTextPart(p: PromptPart): p is TextPart {
  return p.type === "text" && typeof (p as TextPart).text === "string";
}

function rehydrateStream(
  source: ReadableStream<StreamPart>,
  shield: Shield,
): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (isTextDelta(value)) {
            const safe = await shield.rehydrateChunk(value.textDelta);
            if (safe.length > 0) {
              controller.enqueue({ ...value, textDelta: safe });
            }
          } else {
            controller.enqueue(value);
          }
        }
        const tail = await shield.flush();
        if (tail.length > 0) {
          controller.enqueue({ type: "text-delta", textDelta: tail });
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function isTextDelta(p: StreamPart): p is TextDeltaPart {
  return (
    p.type === "text-delta" &&
    typeof (p as TextDeltaPart).textDelta === "string"
  );
}
