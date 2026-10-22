import { z } from "zod";
import type { FetchLike } from "./adapter.ts";

/**
 * Small HTTP layer shared by live adapters: timeouts combined with the
 * caller's signal, bounded retries for transient failures, same-origin checks
 * for followed links, and status-code-based errors that never echo response
 * bodies or credentials.
 */

export type HttpErrorKind =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "server"
  | "client"
  | "network"
  | "timeout"
  | "invalid_response";

export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  constructor(
    message: string,
    readonly kind: HttpErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Statuses retried at most {@link MAX_RETRIES} times. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
export const MAX_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 10_000;
const BACKOFF_MS = [500, 1000];

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export const httpUrlSchema = z
  .string({ error: "must be a string" })
  .refine(isHttpUrl, { error: "must be an http(s) URL without embedded credentials" });

/** `https://host/sub` + `api/v4` → `https://host/sub/api/v4/` (trailing slash for relative resolution). */
export function apiBase(baseUrl: string, suffix: string): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const path = suffix.replace(/^\/+/, "").replace(/\/?$/, "/");
  return new URL(path, base);
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds, capped. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Parses vendor timestamps, accepting `+0000`-style offsets (Jira) as well as ISO 8601. */
export function parseTimestamp(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export interface HttpClientOptions {
  /** Vendor name used in messages, e.g. "GitLab". */
  label: string;
  /** API root; requests and followed links must stay on its origin. */
  base: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  fetch: FetchLike;
  sleep?: Sleep | undefined;
  /** Where the credential comes from (e.g. `$GITLAB_TOKEN`), for auth errors. Never the value. */
  credentialHint: string;
}

export interface RequestContext {
  /** What was being done, e.g. "listing commits for acme/api". */
  action: string;
  /** Resource named in 403/404 messages, e.g. "project acme/api". */
  resource?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class HttpClient {
  readonly #options: HttpClientOptions;
  readonly #sleep: Sleep;

  constructor(options: HttpClientOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get base(): URL {
    return this.#options.base;
  }

  /** Resolves a path relative to the API root. */
  url(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), this.#options.base);
  }

  /** Throws unless the URL shares the API root's origin (credentials must not leak). */
  assertSameOrigin(url: URL): URL {
    if (url.origin !== this.#options.base.origin) {
      throw new ProviderHttpError(
        `${this.#options.label} returned a link to a different host; refusing to follow it.`,
        "invalid_response",
      );
    }
    return url;
  }

  /** GET with timeout and bounded retries. Returns any final response; see {@link ensureOk}. */
  async request(url: URL, context: RequestContext): Promise<Response> {
    this.assertSameOrigin(url);
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetchOnce(url, context);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) return response;
      await response.body?.cancel();
      const delay =
        retryAfterMs(response.headers.get("retry-after")) ?? BACKOFF_MS[attempt] ?? 1000;
      await this.#sleep(delay, context.signal);
    }
  }

  /** GET, require 2xx, and validate the JSON body. */
  async getJson<T>(
    url: URL,
    schema: z.ZodType<T>,
    context: RequestContext,
  ): Promise<{ data: T; response: Response }> {
    const response = await this.request(url, context);
    await this.ensureOk(response, context);
    return { data: await this.parseJson(response, schema, context), response };
  }

  async parseJson<T>(
    response: Response,
    schema: z.ZodType<T>,
    context: RequestContext,
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw this.#invalid(context);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw this.#invalid(context);
    return parsed.data;
  }

  /** Maps non-2xx responses to {@link ProviderHttpError}. The body is discarded, never echoed. */
  async ensureOk(response: Response, context: RequestContext): Promise<void> {
    if (response.ok) return;
    await response.body?.cancel();
    const { label, credentialHint } = this.#options;
    const { action, resource } = context;
    const status = response.status;
    if (status === 401) {
      throw new ProviderHttpError(
        `${label} rejected the credentials while ${action} (HTTP 401). Check the token in ${credentialHint}.`,
        "auth",
        status,
      );
    }
    if (status === 403) {
      const target = resource ? ` to ${resource}` : "";
      throw new ProviderHttpError(
        `${label} denied access${target} while ${action} (HTTP 403). Check the token's permissions.`,
        "permission",
        status,
      );
    }
    if (status === 404) {
      throw new ProviderHttpError(
        resource
          ? `${resource} was not found on ${label}, or the token cannot access it (HTTP 404).`
          : `${label} returned HTTP 404 while ${action}.`,
        "not_found",
        status,
      );
    }
    if (status === 429) {
      throw new ProviderHttpError(
        `${label} rate limit exceeded while ${action} (still limited after ${MAX_RETRIES} retries).`,
        "rate_limit",
        status,
      );
    }
    if (status >= 500) {
      throw new ProviderHttpError(
        `${label} server error while ${action} (HTTP ${status}).`,
        "server",
        status,
      );
    }
    throw new ProviderHttpError(
      `${label} request failed while ${action} (HTTP ${status}).`,
      "client",
      status,
    );
  }

  async #fetchOnce(url: URL, context: RequestContext): Promise<Response> {
    const { label, timeoutMs } = this.#options;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      return await this.#options.fetch(url.toString(), {
        method: "GET",
        headers: { "User-Agent": "devzy", ...this.#options.headers },
        signal,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new ProviderHttpError(
          `${label} request timed out after ${timeoutMs} ms while ${context.action}.`,
          "timeout",
        );
      }
      if (context.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderHttpError(
        `Could not reach ${label} at ${this.#options.base.origin} while ${context.action}: ${reason}`,
        "network",
      );
    }
  }

  #invalid(context: RequestContext): ProviderHttpError {
    return new ProviderHttpError(
      `Unexpected response from ${this.#options.label} while ${context.action}.`,
      "invalid_response",
    );
  }
}

/** Extracts the `rel="next"` URL from an RFC 8288 `Link` header. */
export function nextLink(header: string | null): URL | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1]) return new URL(match[1]);
  }
  return undefined;
}
