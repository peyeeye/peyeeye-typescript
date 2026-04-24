import { describe, expect, it } from "vitest";
import { Peyeeye, PeyeeyeError, parseSSE } from "../src/index.js";
import { createMockFetch } from "./helpers.js";

const API_KEY = "pk_test_stream";

describe("redactStream", () => {
  it("iterates over SSE events", async () => {
    const { fetch } = createMockFetch(async () => ({
      sseLines: [
        "event: session\n",
        'data: {"session":"ses_abc"}\n',
        "\n",
        "event: redacted\n",
        'data: {"text":"Hi [PERSON_1]","entities":1}\n',
        "\n",
        "event: redacted\n",
        'data: {"text":" — card [CARD_1]","entities":1}\n',
        "\n",
        "event: done\n",
        'data: {"chars":37}\n',
        "\n",
      ],
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    const events: unknown[] = [];
    for await (const e of client.redactStream(["Hi Ada", " card 4242 4242 4242 4242"])) {
      events.push(e);
    }
    expect(events).toEqual([
      { event: "session", data: { session: "ses_abc" } },
      { event: "redacted", data: { text: "Hi [PERSON_1]", entities: 1 } },
      { event: "redacted", data: { text: " — card [CARD_1]", entities: 1 } },
      { event: "done", data: { chars: 37 } },
    ]);
  });

  it("surfaces errors from the streaming endpoint", async () => {
    const { fetch } = createMockFetch(async () => ({
      status: 403,
      body: { code: "forbidden", message: "Streaming requires Build." },
    }));
    const client = new Peyeeye({ apiKey: API_KEY, fetch });
    let caught: unknown = null;
    try {
      for await (const _e of client.redactStream(["hi"])) {
        void _e;
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PeyeeyeError);
    expect((caught as PeyeeyeError).code).toBe("forbidden");
  });
});

describe("parseSSE", () => {
  it("handles CRLF and comments", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(": keep-alive\r\nevent: ping\r\ndata: {\"ok\":true}\r\n\r\n"));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSSE(stream)) events.push(e);
    expect(events).toEqual([{ event: "ping", data: { ok: true } }]);
  });

  it("emits a default 'message' event when none is specified", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"x":1}\n\n'));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSSE(stream)) events.push(e);
    expect(events).toEqual([{ event: "message", data: { x: 1 } }]);
  });
});
