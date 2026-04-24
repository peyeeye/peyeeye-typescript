# peyeeye

[![npm version](https://img.shields.io/npm/v/peyeeye.svg)](https://www.npmjs.com/package/peyeeye)
[![license](https://img.shields.io/npm/l/peyeeye.svg)](https://www.npmjs.com/package/peyeeye)

Official TypeScript SDK for [peyeeye.ai](https://peyeeye.ai) — redact PII on the
way _into_ your LLM prompts and rehydrate it on the way out. One round-trip,
deterministic tokens, zero data retention by default.

- Works on Node 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.
- Zero runtime dependencies. Uses the platform `fetch`.
- Dual ESM + CJS build with typed `.d.ts` / `.d.cts`.
- Streaming (SSE) redact, stateless sealed mode, custom detectors — full parity
  with the HTTP API documented at <https://peyeeye.ai/docs>.

```bash
npm install peyeeye
```

## Quickstart

```ts
import { Peyeeye } from "peyeeye";
import Anthropic from "@anthropic-ai/sdk";

const peyeeye = new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
const claude  = new Anthropic();

const shield = await peyeeye.shield();
const safe   = await shield.redact("Hi, I'm Ada, ada@a-e.com");

const reply = await claude.messages.create({
  model: "claude-sonnet-*",
  max_tokens: 256,
  messages: [{ role: "user", content: safe }],
});

console.log(await shield.rehydrate(reply.content[0].text));
// "Hi Ada, thanks — we've emailed ada@a-e.com."
```

`shield()` opens a session on first `redact()`, keeps using it across calls,
and swaps tokens back on `rehydrate()`. The same real value always yields the
same token inside one shield, and tokens never leak across shields.

## Configuration

```ts
new Peyeeye({
  apiKey: "pk_live_…",
  baseUrl: "https://api.peyeeye.ai", // optional
  maxRetries: 3,                     // default; 429 + 5xx back off exponentially
  timeoutMs: 30_000,                 // default per-request timeout
  defaultHeaders: { "X-App": "my-app" },
  fetch: globalThis.fetch,           // override e.g. for Cloudflare Workers
});
```

All requests send `Authorization: Bearer <apiKey>`. Never ship the key to a
browser — proxy the redact + rehydrate calls from your backend.

## Low-level calls

```ts
const r = await peyeeye.redact("Card: 4242 4242 4242 4242");
// r.redacted → "Card: [CARD_1]"
// r.session  → "ses_…"
// r.entities → [{ token: "[CARD_1]", type: "CARD", span: [6, 25], confidence: 0.99 }]

const clean = await peyeeye.rehydrate("Confirmation for [CARD_1].", r.session);
// clean.text → "Confirmation for 4242 4242 4242 4242."
```

Array input is processed in one session and mirrored on output:

```ts
const r = await peyeeye.redact(["Hi Ada", "email ada@a.com"]);
// r.redacted[0] → "Hi [PERSON_1]"
// r.redacted[1] → "email [EMAIL_1]"
```

### Idempotency

```ts
await peyeeye.redact(text, { idempotencyKey: "req_a1b2c3" });
```

Mismatched bodies with the same key raise `idempotency_conflict` (409). Same
body is served from the cache instantly.

## Stateless sealed mode

Skip server-side storage entirely. The response includes a
`rehydration_key` (`skey_…`) — an AES-256-GCM-sealed blob of the token→value
mapping. Store it yourself, hand it back to `rehydrate` as the session:

```ts
const r = await peyeeye.redact("Email ada@a-e.com", { session: "stateless" });
// r.rehydration_key → "skey_…"

const clean = await peyeeye.rehydrate("[EMAIL_1] received.", r.rehydration_key!);
```

Or via a shield:

```ts
const shield = await peyeeye.shield({ stateless: true });
await shield.redact("Email ada@a-e.com");
// shield.rehydrationKey holds the skey_… blob if you need to persist it
await shield.rehydrate("[EMAIL_1] received.");
```

## Streaming

### `redactStream()` (SSE — Build plan and higher)

```ts
for await (const ev of peyeeye.redactStream(["Hi Ada", " card 4242 4242 4242 4242"])) {
  if (ev.event === "session")  console.log("session:", ev.data.session);
  if (ev.event === "redacted") process.stdout.write(ev.data.text);
  if (ev.event === "done")     console.log("\ntotal chars:", ev.data.chars);
}
```

### Rehydrate an LLM token stream safely

Naive rehydration breaks when a chunk ends mid-token (`"Hi [PERS"`). The shield
buffers the partial token until the next chunk closes it:

```ts
const shield = await peyeeye.shield();
const safe   = await shield.redact(userInput);

const upstream = await claude.messages.stream({
  model: "claude-sonnet-*",
  messages: [{ role: "user", content: safe }],
});

for await (const chunk of upstream) {
  process.stdout.write(await shield.rehydrateChunk(chunk));
}
process.stdout.write(await shield.flush()); // emit any buffered tail
```

Never call `flush()` while upstream is still delivering chunks — you can emit
a half-formed token.

## Custom detectors

```ts
await peyeeye.createEntity({
  id: "ORDER_ID",
  kind: "regex",
  pattern: "#A-\\d{6,}",
  examples: ["#A-884217", "#A-007431"],
  confidence_floor: 0.9,
});

// dry-run a pattern before saving
await peyeeye.testPattern({ pattern: "#A-\\d+", text: "#A-884217 and #A-1" });
// → { matches: [{ value: "#A-884217", start: 0, end: 9 }], count: 1 }

// list / update / retire
await peyeeye.listEntities();
await peyeeye.updateEntity("ORDER_ID", { enabled: false });
await peyeeye.deleteEntity("ORDER_ID");

// starter templates (Stripe keys, Twilio SIDs, JWTs, Slack tokens, …)
for (const t of await peyeeye.entityTemplates()) {
  console.log(t.id, t.pattern);
}
```

Plan gates: Free 0, Build 3, Pro 10, Scale unlimited. Over-cap returns
`403 forbidden`.

## Sessions

```ts
await peyeeye.getSession("ses_…");    // → SessionInfo
await peyeeye.deleteSession("ses_…"); // drop immediately, don't wait for TTL
```

## Errors

Every non-2xx raises `PeyeeyeError`:

```ts
import { PeyeeyeError } from "peyeeye";

try {
  await peyeeye.redact(input);
} catch (e) {
  if (e instanceof PeyeeyeError) {
    console.error(e.code, e.status, e.message, e.requestId, e.rateLimit);
    if (e.retryable) { /* 429 / 5xx — SDK already retried up to maxRetries */ }
  }
}
```

Codes the backend uses: `invalid_request`, `unknown_token`, `unauthorized`,
`forbidden`, `not_found`, `session_not_found`, `idempotency_conflict`,
`payload_too_large`, `rate_limited`, `internal_error`.

## Rate limits

Parsed from response headers and surfaced on `PeyeeyeError.rateLimit`:

```ts
{ limit: 500, remaining: 487, retryAfter: null }
```

429s carry `retryAfter` in seconds — the SDK honours it automatically via
exponential backoff, capped at `maxRetries`.

## Environment variables

The SDK itself reads no env vars. Typical usage:

```
PEYEEYE_KEY=pk_live_…
```

```ts
new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
```

## TypeScript types

Everything public is re-exported:

```ts
import type {
  PeyeeyeOptions, RedactOptions, RedactResponse,
  RehydrateOptions, RehydrateResponse,
  DetectedEntity, SessionInfo, RateLimit,
  EntitiesList, CustomDetector, EntityTemplate, StreamEvent,
} from "peyeeye";
```

## Using this SDK from an AI coding assistant

Copy-paste snippets — no fluff.

**Install:** `npm install peyeeye`

**One round-trip through an LLM:**

```ts
import { Peyeeye } from "peyeeye";
const peyeeye = new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
const shield  = await peyeeye.shield();
const safe    = await shield.redact(userInput);
const reply   = await callYourLLM(safe);           // your own code
const out     = await shield.rehydrate(reply);     // tokens → real values
```

**Stateless (no server-side storage):**

```ts
const shield = await peyeeye.shield({ stateless: true });
const safe   = await shield.redact(userInput);
// shield.rehydrationKey is the skey_… blob — persist it if you need to
const out    = await shield.rehydrate(reply);
```

**Stream an LLM response back safely:**

```ts
for await (const chunk of llmStream) {
  process.stdout.write(await shield.rehydrateChunk(chunk));
}
process.stdout.write(await shield.flush());
```

**Register a custom detector:**

```ts
await peyeeye.createEntity({
  id: "ORDER_ID",
  pattern: "#A-\\d{6,}",
  examples: ["#A-884217"],
});
```

## Links

- Homepage: <https://peyeeye.ai>
- API reference: <https://peyeeye.ai/docs>
- Dashboard: <https://peyeeye.ai/dashboard>

## License

MIT.
