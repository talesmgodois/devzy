import { describe, expect, test } from "bun:test";
import {
  apiBase,
  basicAuth,
  HttpClient,
  MAX_RETRY_AFTER_MS,
  nextLink,
  ProviderHttpError,
  parseTimestamp,
  retryAfterMs,
} from "../../services/providers/http.ts";
import type { FetchLike } from "../../services/providers/adapter.ts";
import { recordingSleep, status, stubFetch } from "../http-stub.ts";

const client = (fetch: FetchLike, sleep = recordingSleep().sleep) =>
  new HttpClient({
    label: "Acme",
    base: apiBase("https://api.example.com/root", "api/v1"),
    headers: { Authorization: "Bearer secret-token-value" },
    timeoutMs: 200,
    fetch,
    sleep,
    credentialHint: "$ACME_TOKEN",
  });

const errorOf = async (p: Promise<unknown>) =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as ProviderHttpError;

describe("helpers", () => {
  test("apiBase keeps sub-paths and ends with a slash", () => {
    expect(apiBase("https://git.example.com/gitlab", "api/v4").toString()).toBe(
      "https://git.example.com/gitlab/api/v4/",
    );
    expect(apiBase("https://gitlab.com/", "/api/v4").toString()).toBe("https://gitlab.com/api/v4/");
  });

  test("basicAuth encodes user:password", () => {
    expect(basicAuth("apikey", "abc")).toBe(
      `Basic ${Buffer.from("apikey:abc").toString("base64")}`,
    );
  });

  test("retryAfterMs parses seconds and dates, capped", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("999")).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs(new Date(Date.now() + 2000).toUTCString())).toBeLessThanOrEqual(2000);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });

  test("parseTimestamp accepts Jira-style offsets", () => {
    expect(parseTimestamp("2026-01-31T23:59:59.000+0000")?.toISOString()).toBe(
      "2026-01-31T23:59:59.000Z",
    );
    expect(parseTimestamp("2026-01-01T02:00:00.000+0200")?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseTimestamp("garbage")).toBeUndefined();
  });

  test("nextLink reads rel=next", () => {
    expect(
      nextLink(
        '<https://x.com/a?page=2>; rel="next", <https://x.com/a?page=9>; rel="last"',
      )?.toString(),
    ).toBe("https://x.com/a?page=2");
    expect(nextLink(null)).toBeUndefined();
  });
});

describe("HttpClient", () => {
  test("resolves URLs under the API root and sends headers", async () => {
    const { fetch, calls } = stubFetch(() => status(200));
    const http = client(fetch);
    await http.request(http.url("things/1"), { action: "x" });
    expect(calls[0]?.url.toString()).toBe("https://api.example.com/root/api/v1/things/1");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer secret-token-value");
    expect(calls[0]?.headers["User-Agent"]).toBe("devzy");
  });

  test("refuses other origins", async () => {
    const { fetch, calls } = stubFetch(() => status(200));
    await expect(
      client(fetch).request(new URL("https://evil.example.org/"), { action: "x" }),
    ).rejects.toThrow(/different host/);
    expect(calls).toHaveLength(0);
  });

  test("retries 429/503 at most twice, honouring Retry-After, without real sleeping", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = stubFetch((_u, n) =>
      n === 1 ? status(429, { "retry-after": "2" }) : status(503),
    );
    const http = client(fetch, sleep);
    const response = await http.request(http.url("x"), { action: "x" });
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 1000]);
    expect((await errorOf(http.ensureOk(response, { action: "listing" }))).kind).toBe("server");
  });

  test("recovers when a retry succeeds; never retries other errors", async () => {
    const { fetch, calls } = stubFetch((_u, n) => (n === 1 ? status(502) : status(200)));
    const http = client(fetch);
    expect((await http.request(http.url("x"), { action: "x" })).status).toBe(200);
    expect(calls).toHaveLength(2);
    const once = stubFetch(() => status(500));
    await client(once.fetch).request(http.url("x"), { action: "x" });
    expect(once.calls).toHaveLength(1);
  });

  test.each([
    [
      401,
      "auth",
      /rejected the credentials while listing \(HTTP 401\)\. Check the token in \$ACME_TOKEN/,
    ],
    [403, "permission", /denied access to project p/],
    [404, "not_found", /project p was not found on Acme/],
    [429, "rate_limit", /rate limit exceeded/],
    [500, "server", /server error/],
    [418, "client", /HTTP 418/],
  ] as const)("maps HTTP %d to %s without echoing the body", async (code, kind, pattern) => {
    const http = client(stubFetch(() => status(code)).fetch);
    const error = await errorOf(
      http.ensureOk(status(code, {}, "secret-token-value in body"), {
        action: "listing",
        resource: "project p",
      }),
    );
    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain("secret-token-value");
  });

  test("network failures and timeouts are typed errors", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError("connection refused"));
    const http = client(down);
    const network = await errorOf(http.request(http.url("x"), { action: "listing" }));
    expect(network.kind).toBe("network");
    expect(network.message).toContain("Could not reach Acme at https://api.example.com");

    const hang: FetchLike = (_i, init) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const timeout = await errorOf(client(hang).request(http.url("x"), { action: "listing" }));
    expect(timeout.kind).toBe("timeout");
    expect(timeout.message).toContain("timed out after 200 ms");
  });

  test("invalid JSON or shape is an invalid_response error", async () => {
    const http = client(stubFetch(() => new Response("not json")).fetch);
    const { z } = await import("zod");
    const error = await errorOf(
      http.getJson(http.url("x"), z.object({ a: z.number() }), { action: "reading" }),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.kind).toBe("invalid_response");
  });
});
