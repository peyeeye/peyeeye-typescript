import { vi } from "vitest";

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Minimal fetch mock: given a handler (url, init) => Response-ish, records
 * every call and returns a spyable fetch implementation.
 */
export interface MockFetchResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** If set, provides a streaming body instead of a JSON body. */
  sseLines?: string[];
  /** Throw instead of responding. Useful for exercising network errors. */
  throw?: Error;
}

export type MockFetchHandler = (
  url: string,
  init: RequestInit,
) => MockFetchResponse | Promise<MockFetchResponse>;

export function createMockFetch(handler: MockFetchHandler): {
  fetch: typeof globalThis.fetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const headersObj: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as HeadersInit;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => (headersObj[k.toLowerCase()] = v));
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headersObj[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headersObj[k.toLowerCase()] = v as string;
      }
    }
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? safeParse(rawBody)
        : rawBody == null
          ? undefined
          : rawBody;
    calls.push({
      url: u,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: headersObj,
      body,
    });
    const resp = await handler(u, init ?? {});
    if (resp.throw) throw resp.throw;
    const status = resp.status ?? 200;
    const h = new Headers(resp.headers ?? {});
    if (resp.sseLines) {
      if (!h.has("content-type")) h.set("content-type", "text/event-stream");
      const encoder = new TextEncoder();
      const lines = resp.sseLines;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      return new Response(stream, { status, headers: h });
    }
    const payload =
      resp.body === undefined
        ? null
        : typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body);
    if (payload !== null && !h.has("content-type")) {
      h.set("content-type", "application/json");
    }
    return new Response(payload, { status, headers: h });
  });
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
