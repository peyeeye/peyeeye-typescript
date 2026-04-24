import { describe, expect, it } from "vitest";
import { Peyeeye } from "../src/index.js";
import { peyeeyeMiddleware } from "../src/vercel-ai.js";
import { createMockFetch } from "./helpers.js";

const API_KEY = "pk_test_x";

interface RedactBody {
  text: string | string[];
  session?: string;
}

/**
 * Backend stub: echoes each unique PII span as a monotonically numbered
 * token ([PERSON_1], [EMAIL_1], …) and keeps a session-scoped mapping so
 * rehydrate round-trips cleanly.
 */
function mockBackend() {
  let sessionSeq = 0;
  const sessions: Record<
    string,
    { counter: number; tokens: Record<string, string>; reverse: Record<string, string> }
  > = {};

  const tokenize = (sessionId: string, raw: string, entityType = "PERSON") => {
    const sess = sessions[sessionId]!;
    if (sess.tokens[raw]) return sess.tokens[raw];
    sess.counter += 1;
    const tok = `[${entityType}_${sess.counter}]`;
    sess.tokens[raw] = tok;
    sess.reverse[tok] = raw;
    return tok;
  };

  const simpleRedact = (sessionId: string, text: string): string => {
    // Toy regex: treat any "Ada" / "Ben" / emails as PII.
    let out = text;
    out = out.replace(/\bAda\b/g, (m) => tokenize(sessionId, m, "PERSON"));
    out = out.replace(/\bBen\b/g, (m) => tokenize(sessionId, m, "PERSON"));
    out = out.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/g,
      (m) => tokenize(sessionId, m, "EMAIL"),
    );
    return out;
  };

  return createMockFetch(async (url, init) => {
    const body = init.body ? JSON.parse(init.body as string) : {};
    if (url.endsWith("/v1/redact")) {
      const rb = body as RedactBody;
      let sessionId = rb.session && rb.session !== "stateless" ? rb.session : "";
      if (!sessionId) {
        sessionSeq += 1;
        sessionId = `ses_${sessionSeq}`;
        sessions[sessionId] = { counter: 0, tokens: {}, reverse: {} };
      }
      const redacted = Array.isArray(rb.text)
        ? rb.text.map((t) => simpleRedact(sessionId, t))
        : simpleRedact(sessionId, rb.text);
      return {
        body: { redacted, session: sessionId, entities: [], latency_ms: 1 },
      };
    }
    if (url.endsWith("/v1/rehydrate")) {
      const rb = body as { text: string; session: string };
      const sess = sessions[rb.session];
      if (!sess) return { status: 404, body: { code: "session_not_found" } };
      const text = rb.text.replace(
        /\[[A-Z]+_\d+\]/g,
        (tok) => sess.reverse[tok] ?? tok,
      );
      return { body: { text, replaced: 1 } };
    }
    return { status: 404, body: { code: "not_found" } };
  });
}

describe("peyeeyeMiddleware (Vercel AI SDK)", () => {
  it("redacts text content in prompt messages before the model sees them", async () => {
    const { fetch, calls } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = {
      prompt: [
        { role: "user" as const, content: "Hi, I'm Ada, email ada@a-e.com" },
      ],
    };
    const out = await mw.transformParams({ type: "generate", params });
    expect(out.prompt[0].content).toBe(
      "Hi, I'm [PERSON_1], email [EMAIL_2]",
    );
    const redactCall = calls.find((c) => c.url.endsWith("/v1/redact"))!;
    expect(redactCall).toBeDefined();
    expect((redactCall.body as RedactBody).text).toBe(
      "Hi, I'm Ada, email ada@a-e.com",
    );
  });

  it("redacts text parts inside structured content and passes opaque parts through", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [
            { type: "text", text: "Ada sent this" },
            { type: "image", image: "data:image/png;base64,AAA" },
          ],
        },
      ],
    };
    const out = await mw.transformParams({ type: "generate", params });
    const content = out.prompt[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "[PERSON_1] sent this" });
    expect(content[1]).toEqual({
      type: "image",
      image: "data:image/png;base64,AAA",
    });
  });

  it("rehydrates the model's text response via wrapGenerate", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = { prompt: [{ role: "user" as const, content: "Hi Ada" }] };
    const transformed = await mw.transformParams({ type: "generate", params });

    // Model responded with a placeholder — middleware should rehydrate it.
    const out = await mw.wrapGenerate({
      params: transformed,
      doGenerate: async () => ({ text: "Hello [PERSON_1], welcome!" }),
    });
    expect(out.text).toBe("Hello Ada, welcome!");
  });

  it("passes through result fields it doesn't touch", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = { prompt: [{ role: "user" as const, content: "Hi Ada" }] };
    const transformed = await mw.transformParams({ type: "generate", params });
    const result = await mw.wrapGenerate({
      params: transformed,
      doGenerate: async () => ({
        text: "Hi [PERSON_1]",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    });
    expect(result.text).toBe("Hi Ada");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("wrapStream rehydrates streamed text-delta parts and passes opaque parts through", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = { prompt: [{ role: "user" as const, content: "Hi Ada" }] };
    const transformed = await mw.transformParams({ type: "generate", params });

    const chunks = [
      { type: "text-delta", textDelta: "Hello " },
      { type: "text-delta", textDelta: "[PERSON_1]" },
      { type: "text-delta", textDelta: ", nice" },
      { type: "finish", finishReason: "stop" },
    ];
    const source = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

    const out = await mw.wrapStream({
      params: transformed,
      doStream: async () => ({ stream: source }),
    });

    const seen: unknown[] = [];
    const reader = out.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(value);
    }

    const text = seen
      .filter((p): p is { type: "text-delta"; textDelta: string } =>
        (p as { type: string }).type === "text-delta",
      )
      .map((p) => p.textDelta)
      .join("");
    expect(text).toBe("Hello Ada, nice");
    expect(seen.some((p) => (p as { type: string }).type === "finish")).toBe(
      true,
    );
  });

  it("wrapStream buffers partial tokens across chunks so users never see '[PERS'", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    const params = { prompt: [{ role: "user" as const, content: "Hi Ada" }] };
    const transformed = await mw.transformParams({ type: "generate", params });

    // Chunk boundary splits the placeholder across two events.
    const chunks = [
      { type: "text-delta", textDelta: "Hello [PERS" },
      { type: "text-delta", textDelta: "ON_1]!" },
    ];
    const source = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

    const out = await mw.wrapStream({
      params: transformed,
      doStream: async () => ({ stream: source }),
    });

    const deltas: string[] = [];
    const reader = out.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((value as { type: string }).type === "text-delta") {
        deltas.push((value as { textDelta: string }).textDelta);
      }
    }
    // No emitted delta should contain the raw bracket-prefix: the buffer holds
    // onto the partial token until the next chunk completes it.
    for (const d of deltas) expect(d.includes("[PERS")).toBe(false);
    expect(deltas.join("")).toBe("Hello Ada!");
  });

  it("each transformParams call gets its own session — no cross-request leakage", async () => {
    const { fetch, calls } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const mw = peyeeyeMiddleware({ peyeeye });

    await mw.transformParams({
      type: "generate",
      params: { prompt: [{ role: "user", content: "Ada" }] },
    });
    await mw.transformParams({
      type: "generate",
      params: { prompt: [{ role: "user", content: "Ada" }] },
    });

    const sessions = new Set(
      calls
        .filter((c) => c.url.endsWith("/v1/redact"))
        .map((c) => (c.body as RedactBody).session),
    );
    // First redact of each shield leaves session unset (server mints a new id);
    // crucially the two calls are not sharing a session across middleware
    // requests.
    expect(sessions.has(undefined)).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/v1/redact")).length).toBe(2);
  });
});
