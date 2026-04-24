import { describe, expect, it, vi } from "vitest";
import { Peyeeye, PeyeeyeError } from "../src/index.js";
import { createMockFetch } from "./helpers.js";

const API_KEY = "pk_test_abc";

describe("Peyeeye constructor", () => {
  it("requires an apiKey", () => {
    // @ts-expect-error — intentional
    expect(() => new Peyeeye({})).toThrow(/apiKey/);
  });

  it("falls back to the default base URL", () => {
    const c = new Peyeeye({ apiKey: API_KEY, fetch: vi.fn() as unknown as typeof fetch });
    expect(c.baseUrl).toBe("https://api.peyeeye.ai");
  });

  it("strips trailing slashes from baseUrl", () => {
    const c = new Peyeeye({
      apiKey: API_KEY,
      baseUrl: "https://test.example/v1api/",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(c.baseUrl).toBe("https://test.example/v1api");
  });
});

describe("redact", () => {
  it("sends bearer auth and JSON body", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: {
        redacted: "Hi, I'm [PERSON_1].",
        session: "ses_abc",
        entities: [{ token: "[PERSON_1]", type: "PERSON", span: [8, 12], confidence: 0.98 }],
        latency_ms: 12,
        expires_at: "2026-05-01T00:00:00Z",
      },
      headers: { "X-RateLimit-Limit": "500", "X-RateLimit-Remaining": "499" },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const r = await client.redact("Hi, I'm Ada.", { locale: "en-US", policy: "default" });
    expect(r.session).toBe("ses_abc");
    expect(r.redacted).toBe("Hi, I'm [PERSON_1].");
    expect(r.entities).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.peyeeye.ai/v1/redact");
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      text: "Hi, I'm Ada.",
      locale: "en-US",
      policy: "default",
    });
  });

  it("forwards the Idempotency-Key header", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: { redacted: "", session: "ses_x", entities: [], latency_ms: 1 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    await client.redact("hi", { idempotencyKey: "req_a1" });
    expect(calls[0].headers["idempotency-key"]).toBe("req_a1");
  });

  it("passes array input through unchanged", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: { redacted: ["a", "b"], session: "ses_y", entities: [], latency_ms: 0 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const r = await client.redact(["a", "b"]);
    expect(r.redacted).toEqual(["a", "b"]);
    expect(calls[0].body).toEqual({ text: ["a", "b"] });
  });

  it("supports stateless mode", async () => {
    const { fetch } = createMockFetch(async () => ({
      body: {
        redacted: "[EMAIL_1]",
        session: "stateless",
        rehydration_key: "skey_deadbeef",
        entities: [],
        latency_ms: 3,
      },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const r = await client.redact("a@b.com", { session: "stateless" });
    expect(r.rehydration_key).toBe("skey_deadbeef");
  });
});

describe("rehydrate", () => {
  it("posts text + session", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: { text: "hi Ada", replaced: 1, unknown: [], latency_ms: 2 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const r = await client.rehydrate("hi [PERSON_1]", "ses_abc");
    expect(r.text).toBe("hi Ada");
    expect(r.replaced).toBe(1);
    expect(calls[0].body).toEqual({ text: "hi [PERSON_1]", session: "ses_abc", strict: false });
  });

  it("works with a skey_ sealed blob", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: { text: "hi", replaced: 1, unknown: [], latency_ms: 0 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    await client.rehydrate("[EMAIL_1]", "skey_xyz", { strict: true });
    expect(calls[0].body).toEqual({ text: "[EMAIL_1]", session: "skey_xyz", strict: true });
  });
});

describe("error handling", () => {
  it("raises PeyeeyeError with code/status/requestId/rateLimit", async () => {
    const { fetch } = createMockFetch(async () => ({
      status: 403,
      body: { code: "forbidden", message: "Upgrade to Build.", request_id: "req_777" },
      headers: { "X-RateLimit-Limit": "2", "X-RateLimit-Remaining": "0" },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch, maxRetries: 0 });
    await expect(client.redact("hi")).rejects.toMatchObject({
      name: "PeyeeyeError",
      code: "forbidden",
      status: 403,
      requestId: "req_777",
      rateLimit: { limit: 2, remaining: 0, retryAfter: null },
    });
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const { fetch, calls } = createMockFetch(async () => {
      n++;
      if (n === 1) {
        return {
          status: 429,
          body: { code: "rate_limited", message: "slow down" },
          headers: { "Retry-After": "0" },
        };
      }
      return {
        body: { redacted: "x", session: "ses_z", entities: [], latency_ms: 0 },
      };
    });
    const client = new Peyeeye({ apiKey: API_KEY, fetch, maxRetries: 3 });
    const r = await client.redact("hi");
    expect(r.session).toBe("ses_z");
    expect(calls).toHaveLength(2);
  });

  it("does not retry on 4xx terminal errors", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      status: 400,
      body: { code: "invalid_request", message: "bad" },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch, maxRetries: 3 });
    await expect(client.redact("hi")).rejects.toBeInstanceOf(PeyeeyeError);
    expect(calls).toHaveLength(1);
  });

  it("synthesizes a code from status when body is empty", async () => {
    const { fetch } = createMockFetch(async () => ({
      status: 401,
      body: "",
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch, maxRetries: 0 });
    await expect(client.redact("hi")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });
});

describe("sessions", () => {
  it("GET /v1/sessions/:id", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: {
        id: "ses_a",
        locale: "en",
        policy: "default",
        chars_processed: 40,
        entities_detected: 2,
        created_at: "2026-04-23T00:00:00Z",
        expires_at: "2026-04-23T00:15:00Z",
        expired: false,
      },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const s = await client.getSession("ses_a");
    expect(s.id).toBe("ses_a");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.peyeeye.ai/v1/sessions/ses_a");
  });

  it("DELETE /v1/sessions/:id", async () => {
    const { fetch, calls } = createMockFetch(async () => ({ status: 204 }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    await client.deleteSession("ses_a");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.peyeeye.ai/v1/sessions/ses_a");
  });
});

describe("entities", () => {
  it("lists builtin + custom", async () => {
    const { fetch } = createMockFetch(async () => ({
      body: {
        builtin: [{ id: "EMAIL", category: "Contact", sample: "a@b.com", locales: ["all"] }],
        custom: [{ id: "ORDER", kind: "regex", pattern: "#A-\\d+", enabled: true }],
      },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const list = await client.listEntities();
    expect(list.builtin[0].id).toBe("EMAIL");
    expect(list.custom[0].kind).toBe("regex");
  });

  it("creates a detector", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      status: 201,
      body: { id: "ORDER", kind: "regex", enabled: true },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const d = await client.createEntity({
      id: "ORDER",
      pattern: "#A-\\d+",
      examples: ["#A-1"],
      confidence_floor: 0.9,
    });
    expect(d.id).toBe("ORDER");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      id: "ORDER",
      kind: "regex",
      pattern: "#A-\\d+",
      examples: ["#A-1"],
      confidence_floor: 0.9,
    });
  });

  it("PATCHes a detector", async () => {
    const { fetch, calls } = createMockFetch(async () => ({
      body: { id: "ORDER", kind: "regex", pattern: "#B-\\d+", enabled: false, confidence_floor: 0.8 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    await client.updateEntity("ORDER", { pattern: "#B-\\d+", enabled: false });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.peyeeye.ai/v1/entities/ORDER");
    expect(calls[0].body).toEqual({ pattern: "#B-\\d+", enabled: false });
  });

  it("DELETEs a detector", async () => {
    const { fetch, calls } = createMockFetch(async () => ({ status: 204 }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    await client.deleteEntity("ORDER");
    expect(calls[0].method).toBe("DELETE");
  });

  it("dry-runs a pattern", async () => {
    const { fetch } = createMockFetch(async () => ({
      body: { matches: [{ value: "#A-1", start: 0, end: 4 }], count: 1 },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const r = await client.testPattern({ pattern: "#A-\\d+", text: "#A-1 and #A-2" });
    expect(r.count).toBe(1);
  });

  it("fetches starter templates", async () => {
    const { fetch } = createMockFetch(async () => ({
      body: {
        templates: [
          {
            id: "STRIPE_KEY",
            name: "Stripe API key",
            description: "…",
            kind: "regex",
            pattern: "sk_live_.*",
            example: "sk_live_x",
            category: "Credential",
          },
        ],
      },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const t = await client.entityTemplates();
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe("STRIPE_KEY");
  });
});
