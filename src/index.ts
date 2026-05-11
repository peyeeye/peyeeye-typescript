/**
 * peyeeye — Official TypeScript SDK for the peyeeye.ai PII redaction API.
 *
 * ```ts
 * import { Peyeeye } from "peyeeye";
 *
 * const peyeeye = new Peyeeye({ apiKey: process.env.PEYEEYE_KEY! });
 * const shield  = await peyeeye.shield();
 * const safe    = await shield.redact("Hi, I'm Ada, ada@a-e.com");
 * const reply   = await callYourLLM(safe);
 * console.log(await shield.rehydrate(reply));
 * ```
 *
 * A single `Peyeeye` instance is safe to share across concurrent
 * requests; create one at startup and reuse it.
 *
 * See https://peyeeye.ai/docs for the full API reference.
 */

export { Peyeeye } from "./client.js";
export { Shield } from "./shield.js";
export { PeyeeyeError } from "./errors.js";
export { parseSSE } from "./sse.js";

export type {
  BuiltinEntity,
  CreateEntityOptions,
  CustomDetector,
  DetectedEntity,
  EntitiesList,
  EntityTemplate,
  Locale,
  PatternMatch,
  PeyeeyeOptions,
  Policy,
  RateLimit,
  RedactOptions,
  RedactResponse,
  RehydrateOptions,
  RehydrateResponse,
  SessionInfo,
  SessionRef,
  StreamEvent,
  StreamRedactOptions,
  TestPatternResponse,
  UpdateEntityOptions,
} from "./types.js";

import { Peyeeye } from "./client.js";
export default Peyeeye;
