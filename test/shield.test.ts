import { describe, expect, it } from "vitest";
import { Peyeeye } from "../src/index.js";
import { createMockFetch } from "./helpers.js";

const API_KEY = "pk_test_x";

describe("Shield", () => {
  it("establishes a session on first redact and reuses it", async () => {
    const responses = [
      {
        body: {
          redacted: "Hi [PERSON_1]",
          session: "ses_first",
          entities: [],
          latency_ms: 1,
        },
      },
      {
        body: {
          redacted: "Call [PERSON_1]",
          session: "ses_first",
          entities: [],
          latency_ms: 1,
        },
      },
    ];
    let i = 0;
    const { fetch, calls } = createMockFetch(async () => responses[i++]!);
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield({ locale: "en-US" });
    expect(shield.sessionId).toBe("");
    const first = await shield.redact("Hi Ada");
    expect(first).toBe("Hi [PERSON_1]");
    expect(shield.sessionId).toBe("ses_first");
    await shield.redact("Call Ada");
    expect(calls[0].body).toMatchObject({ locale: "en-US" });
    expect((calls[0].body as Record<string, unknown>).session).toBeUndefined();
    expect(calls[1].body).toMatchObject({ session: "ses_first", locale: "en-US" });
  });

  it("rehydrate uses the stored session id", async () => {
    let call = 0;
    const { fetch, calls } = createMockFetch(async () => {
      call++;
      if (call === 1) {
        return {
          body: {
            redacted: "Email [EMAIL_1]",
            session: "ses_s",
            entities: [],
            latency_ms: 0,
          },
        };
      }
      return {
        body: { text: "Email ada@a.com", replaced: 1, unknown: [], latency_ms: 0 },
      };
    });
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield();
    await shield.redact("Email ada@a.com");
    const out = await shield.rehydrate("Email [EMAIL_1]");
    expect(out).toBe("Email ada@a.com");
    expect(calls[1].body).toMatchObject({ session: "ses_s", text: "Email [EMAIL_1]" });
  });

  it("stateless mode uses the rehydration key", async () => {
    let call = 0;
    const { fetch, calls } = createMockFetch(async () => {
      call++;
      if (call === 1) {
        return {
          body: {
            redacted: "[EMAIL_1]",
            session: "stateless",
            rehydration_key: "skey_abc",
            entities: [],
            latency_ms: 0,
          },
        };
      }
      return { body: { text: "a@b.com", replaced: 1, unknown: [], latency_ms: 0 } };
    });
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield({ stateless: true });
    await shield.redact("a@b.com");
    expect(shield.rehydrationKey).toBe("skey_abc");
    await shield.rehydrate("[EMAIL_1]");
    expect(calls[1].body).toMatchObject({ session: "skey_abc" });
  });

  it("throws if rehydrate called before redact", async () => {
    const { fetch } = createMockFetch(async () => ({ body: {} }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield();
    await expect(shield.rehydrate("x")).rejects.toThrow(/no session/);
  });

  it("rehydrateChunk holds back partial tokens", async () => {
    // Only two rehydrate calls should go out: "Hi " (safe head of chunk1),
    // then "Ada" for the final flush after chunk2 completes the token.
    const chunks: string[] = [];
    let n = 0;
    const { fetch, calls } = createMockFetch(async (_u, init) => {
      n++;
      if (n === 1) {
        // Priming redact call.
        return {
          body: {
            redacted: "Hi [PERSON_1]",
            session: "ses_s",
            entities: [],
            latency_ms: 0,
          },
        };
      }
      const body = JSON.parse(init.body as string) as { text: string };
      chunks.push(body.text);
      return {
        body: {
          text: body.text.replace("[PERSON_1]", "Ada"),
          replaced: body.text.includes("[PERSON_1]") ? 1 : 0,
          unknown: [],
          latency_ms: 0,
        },
      };
    });
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield();
    await shield.redact("Hi Ada");
    // Stream in two chunks that split a token boundary.
    const out1 = await shield.rehydrateChunk("Hi [PERS");
    expect(out1).toBe("Hi "); // "[PERS" held back
    const out2 = await shield.rehydrateChunk("ON_1] there");
    expect(out2).toBe("Ada there");
    const tail = await shield.flush();
    expect(tail).toBe("");
    // Two rehydrate POSTs fired — one per safe slice.
    expect(chunks).toEqual(["Hi ", "[PERSON_1] there"]);
    expect(calls).toHaveLength(3); // redact + 2× rehydrate
  });

  it("destroy DELETEs the session", async () => {
    let n = 0;
    const { fetch, calls } = createMockFetch(async () => {
      n++;
      if (n === 1) {
        return {
          body: { redacted: "x", session: "ses_kill", entities: [], latency_ms: 0 },
        };
      }
      return { status: 204 };
    });
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const shield = await client.shield();
    await shield.redact("x");
    await shield.destroy();
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].url).toContain("/v1/sessions/ses_kill");
    expect(shield.sessionId).toBe("");
  });
});
