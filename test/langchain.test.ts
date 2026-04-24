import { describe, expect, it } from "vitest";
import { Peyeeye } from "../src/index.js";
import { withPeyeeye } from "../src/langchain.js";
import { createMockFetch } from "./helpers.js";

const API_KEY = "pk_test_x";

interface RedactBody {
  text: string | string[];
  session?: string;
}

/**
 * Same toy PII backend the vercel-ai tests use: tokenizes `Ada`, `Ben`, and
 * email addresses per-session and resolves tokens on rehydrate.
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
      const resp: Record<string, unknown> = {
        redacted,
        session: sessionId,
        entities: [],
        latency_ms: 1,
      };
      if ((rb as RedactBody).session === "stateless") {
        resp.rehydration_key = sessionId;
      }
      return { body: resp };
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

/** Stand-in for LangChain AIMessage — holds a `.content` and a role. */
class FakeMessage {
  constructor(
    public content: unknown,
    public role: string = "ai",
  ) {}
}

/**
 * Fake chat model: echoes the last "user-visible" string back so we can check
 * that the inner runnable only ever sees redacted text.
 */
function echoModel() {
  const captured: { lastInput: unknown } = { lastInput: null };
  const invoke = async (input: unknown) => {
    captured.lastInput = input;
    const text = extractText(input);
    return new FakeMessage(`You said: ${text}`);
  };
  return { invoke, captured };
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    const last = value[value.length - 1];
    if (Array.isArray(last) && last.length === 2) return String(last[1]);
    if (last && typeof last === "object" && "content" in last) {
      const c = (last as { content: unknown }).content;
      if (typeof c === "string") return c;
    }
  }
  if (value && typeof value === "object" && "content" in value) {
    const c = (value as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return String(value);
}

describe("withPeyeeye (LangChain.js)", () => {
  it("string prompt: inner model sees only redacted text, output is rehydrated", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    const reply = (await wrapped.invoke("Hi, I'm Ada — email ada@a-e.com")) as FakeMessage;

    const sent = model.captured.lastInput as string;
    expect(typeof sent).toBe("string");
    expect(sent).not.toContain("Ada");
    expect(sent).not.toContain("ada@a-e.com");
    expect(sent).toMatch(/\[PERSON_\d+\]/);
    expect(sent).toMatch(/\[EMAIL_\d+\]/);

    expect(reply.content).toContain("Ada");
    expect(reply.content).toContain("ada@a-e.com");
    expect(reply.content).not.toMatch(/\[PERSON_/);
  });

  it("chat-message array: redacts content on each message", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    const messages = [
      new FakeMessage("You are helpful.", "system"),
      new FakeMessage("Ben asked me to reach Ada", "human"),
    ];
    const reply = (await wrapped.invoke(messages)) as FakeMessage;

    const sent = model.captured.lastInput as FakeMessage[];
    expect(Array.isArray(sent)).toBe(true);
    expect(sent[0].content).toBe("You are helpful.");
    expect(sent[1].content).not.toContain("Ada");
    expect(sent[1].content).not.toContain("Ben");
    expect(sent[1].content).toContain("[PERSON_1]");
    expect(sent[1].content).toContain("[PERSON_2]");

    expect(String(reply.content)).toMatch(/Ada|Ben/);
  });

  it('tuple shorthand messages (["human", "text"]) get redacted', async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    await wrapped.invoke([
      ["system", "Be kind."],
      ["human", "Hi Ada"],
    ]);

    const sent = model.captured.lastInput as Array<[string, string]>;
    expect(sent[0]).toEqual(["system", "Be kind."]);
    expect(sent[1][0]).toBe("human");
    expect(sent[1][1]).not.toContain("Ada");
    expect(sent[1][1]).toContain("[PERSON_1]");
  });

  it("dict messages ({role, content}) are redacted", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    await wrapped.invoke([{ role: "user", content: "Ada sends regards to ben@e.com" }]);

    const sent = model.captured.lastInput as Array<{ content: string }>;
    expect(sent[0].content).not.toContain("Ada");
    expect(sent[0].content).not.toContain("ben@e.com");
    expect(sent[0].content).toMatch(/\[PERSON_/);
    expect(sent[0].content).toMatch(/\[EMAIL_/);
  });

  it("multimodal content: text parts redacted, image parts pass through", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    const msg = new FakeMessage(
      [
        { type: "text", text: "Ada is in this photo:" },
        { type: "image_url", image_url: "https://example.com/ada.png" },
      ],
      "human",
    );
    await wrapped.invoke([msg]);

    const sent = model.captured.lastInput as FakeMessage[];
    const parts = sent[0].content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "[PERSON_1] is in this photo:" });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: "https://example.com/ada.png",
    });
  });

  it("plain-string output models still get rehydrated", async () => {
    const { fetch } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const echoString = { invoke: async (x: unknown) => String(x) };
    const wrapped = withPeyeeye(echoString, { peyeeye });

    const out = await wrapped.invoke("Hello Ada");
    expect(out).toBe("Hello Ada");
  });

  it("each invoke opens a fresh session (no session id in the redact body)", async () => {
    const { fetch, calls } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    await wrapped.invoke("Hi Ada");
    await wrapped.invoke("Hi Ben");

    const redacts = calls.filter((c) => c.url.endsWith("/v1/redact"));
    expect(redacts).toHaveLength(2);
    for (const c of redacts) {
      expect((c.body as RedactBody).session).toBeUndefined();
    }
  });

  it("stateless=true: opens a sealed session", async () => {
    const { fetch, calls } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye, stateless: true });

    await wrapped.invoke("Hi Ada");

    const redact = calls.find((c) => c.url.endsWith("/v1/redact"))!;
    expect((redact.body as RedactBody).session).toBe("stateless");
  });

  it("batch runs each item in its own session", async () => {
    const { fetch, calls } = mockBackend();
    const peyeeye = new Peyeeye({ apiKey: API_KEY, fetch });
    const model = echoModel();
    const wrapped = withPeyeeye(model, { peyeeye });

    const results = (await wrapped.batch(["Hi Ada", "Hi Ben"])) as FakeMessage[];

    expect(results).toHaveLength(2);
    const redacts = calls.filter((c) => c.url.endsWith("/v1/redact"));
    expect(redacts).toHaveLength(2);
    for (const c of redacts) {
      expect((c.body as RedactBody).session).toBeUndefined();
    }
    // Rehydration round-tripped both — no raw tokens escape.
    for (const r of results) {
      expect(String(r.content)).not.toMatch(/\[PERSON_/);
    }
  });
});
