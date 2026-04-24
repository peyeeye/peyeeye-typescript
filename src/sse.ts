/**
 * Minimal Server-Sent Events parser.
 *
 * Reads from a `ReadableStream<Uint8Array>` (as returned by `fetch` in Node 18+,
 * Bun, Deno, Cloudflare Workers, and browsers) and yields `{ event, data }`
 * pairs where `data` is JSON-parsed.
 */

import type { StreamEvent } from "./types.js";

const NEWLINE = /\r\n|\n|\r/;

function parseData(lines: string[]): Record<string, unknown> {
  const raw = lines.join("\n");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = (): StreamEvent | null => {
    if (event === null && dataLines.length === 0) return null;
    const out: StreamEvent = {
      event: event ?? "message",
      data: parseData(dataLines),
    } as StreamEvent;
    event = null;
    dataLines = [];
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = NEWLINE.exec(buffer);
        if (!match) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          const evt = flush();
          if (evt) yield evt;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const valueRaw =
          colon === -1
            ? ""
            : line[colon + 1] === " "
              ? line.slice(colon + 2)
              : line.slice(colon + 1);
        if (field === "event") event = valueRaw;
        else if (field === "data") dataLines.push(valueRaw);
      }
    }
    // Final buffered line (no trailing newline).
    buffer += decoder.decode();
    if (buffer) {
      if (buffer.startsWith("event:")) event = buffer.slice(6).trim();
      else if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
