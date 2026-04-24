# AGENTS.md — peyeeye-typescript

Orientation for AI coding agents working on the official TypeScript/Node SDK for peyeeye.ai. Humans: read `README.md` first.

## What this is

`peyeeye` — TypeScript client for the peyeeye PII redaction / rehydration API. Runs on Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge. Published to npm as `peyeeye`; current version `1.0.0`.

## Layout

```
src/
  index.ts          Public barrel — exports Peyeeye, Shield, PeyeeyeError, parseSSE, types
  client.ts         Peyeeye class: redact, rehydrate, streaming, sessions, entities
  shield.ts         Shield helper: session lifecycle + rehydrate
  sse.ts            parseSSE — server-sent-event line parser
  errors.ts         PeyeeyeError (status + code + request id)
  types.ts          All public type definitions
test/               vitest, one file per feature
tsup.config.ts      Dual ESM + CJS build, emits .d.ts and .d.cts
package.json        Dual exports map, "type": "module", engines.node >= 18
```

## Build & test

```
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup — outputs dist/index.{js,cjs,d.ts,d.cts}
```

`prepublishOnly` runs typecheck + test + build. Don't bypass it.

## Load-bearing invariants

- **Zero runtime dependencies.** Uses the platform `fetch`. Do not add `node-fetch`, `undici`, `axios`, `cross-fetch`, etc. Users run this on Workers/Edge where every added dep risks breaking the runtime. `devDependencies` is where build/test tooling lives.
- **Dual ESM + CJS output.** `package.json#exports` maps both `import` and `require`. `tsup` emits `.d.ts` for ESM and `.d.cts` for CJS. Don't delete either — CJS consumers will break.
- **`"sideEffects": false`** in `package.json`. Keep it — it enables tree-shaking. If you add a module with side effects (top-level mutation of a shared global), enumerate it explicitly; don't flip the flag globally.
- **Edge runtime compatibility.** No `Buffer`, no `process.version` branching, no `fs`, no `path`. `globalThis.fetch` is the only I/O. `client.ts` accepts a `fetch` override in options for runtimes that gate the global.
- **SSE streaming via `parseSSE`** consumes a `ReadableStream<Uint8Array>` and yields `StreamEvent`s. The SDK does not buffer partial tokens on the TS side — `Shield.rehydrate()` handles completed strings only. If/when a `rehydrateChunk` equivalent lands, match the Python SDK's `_PARTIAL_TOKEN_TAIL` regex exactly so behavior is identical across SDKs.
- **Retries**: exponential back-off on 429 + 5xx (`maxRetries` default 3). Honors `Retry-After`. 4xx other than 429 bubble up as `PeyeeyeError` without retry.
- **`Idempotency-Key` is caller-supplied**, not auto-generated.

## Auth

Bearer API key in `Authorization`. `pk_live_…` / `pk_test_…`. `apiKey` is required — constructor throws if missing or empty. Never log or echo the key; `PeyeeyeError.toString()` must not include it.

## Stateless sealed mode

`peyeeye.redact({ session: "stateless", ... })` returns a response with `rehydrationKey: "skey_…"`. Pass that string back as `session` on `rehydrate`. Treat `skey_…` as opaque — do not parse, trim, or validate it on the client.

## Versioning

SemVer. The `v1` in the URL is the HTTP API version, not the SDK version. `USER_AGENT` in `client.ts` must match `package.json#version`.

## What NOT to do

- **Never** add a runtime dependency. Zero-deps is the whole value prop for edge users.
- **Never** import Node built-ins (`node:fs`, `node:crypto`, `node:buffer`) in `src/**`. If you need crypto, use `globalThis.crypto.subtle`.
- **Never** use `require()` from inside the ESM build output, or `import()` from inside the CJS build output.
- **Never** log or serialize `apiKey`.
- **Do not** drop `.d.cts` — CJS consumers lose types silently.
- **Do not** async-iterate over `fetch` response bodies using Node-only helpers. `ReadableStream` + `getReader()` works everywhere this SDK claims to run.
- **Do not** invent endpoints. `https://peyeeye.ai/docs` and the backend's `api/urls.py` are the source of truth.

## Where to look

- Transport, retries, idempotency: `src/client.ts`
- Session helper: `src/shield.ts`
- SSE parser: `src/sse.ts`
- Typed errors: `src/errors.ts`
- Public types: `src/types.ts`
- Tests: `test/*.test.ts` — `client`, `shield`, `streaming`
- Public API docs: https://peyeeye.ai/docs
