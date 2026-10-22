import type { FetchLike } from "../services/providers/adapter.ts";

export interface RecordedCall {
  url: URL;
  headers: Record<string, string>;
}

/** A fetch stub that routes requests and records them (no network). */
export function stubFetch(route: (url: URL, call: number) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return route(url, calls.length);
  };
  return { fetch, calls };
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });

export const status = (code: number, headers: Record<string, string> = {}, body = "{}"): Response =>
  new Response(body, { status: code, headers });

/** Sleep stub that records requested delays and returns immediately. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}
