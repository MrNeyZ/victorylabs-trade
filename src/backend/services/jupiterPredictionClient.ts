/**
 * Thin, typed read-only wrapper around the Jupiter Prediction REST API
 * (`api.jup.ag/prediction/v1` — the documented, sanctioned base URL per
 * `docs/jupiter-prediction-discovery.md` §2; `prediction-market-api.jup.ag`'s
 * `/api/v2/*` endpoints are deliberately NOT wired here, since research
 * flagged that host's support status as an open question — see
 * `docs/rest-api-capabilities.md` §1).
 *
 * This is a request-shaped wrapper: no caching, no persistence. It DOES
 * now handle 429 rate-limiting with a small, bounded retry (added
 * Phase 2.6) — see `request()` below. Everything else (polling loops,
 * batching wallets, deciding what to ingest) still belongs to the
 * ingestion services built on top of this client.
 *
 * Rate-limit handling, confirmed against live headers (2026-07-06, both
 * this project's earlier `scripts/validate-rest-api.mjs` probe and a
 * fresh re-check for this phase): responses carry
 * `x-ratelimit-remaining`/`x-ratelimit-current`/`x-ratelimit-reset`
 * (reset = unix seconds), but NOT a `retry-after` header in practice —
 * `retry-after` is still checked first (it's the correct HTTP-standard
 * signal when present), falling back to `x-ratelimit-reset`, then to a
 * small fixed backoff if neither header is present.
 */

import type {
  JupiterHistoryV1Response,
  JupiterLeaderboardEntry,
  JupiterLeaderboardMetric,
  JupiterLeaderboardPeriod,
  JupiterLeaderboardsResponse,
  JupiterMarket,
  JupiterPosition,
  JupiterPositionsV1Response,
  JupiterProfile,
  JupiterTrade,
  JupiterTradesResponse,
  JupiterErrorResponse,
} from '../types/jupiter.js';
import { sleep } from '../utils/time.js';

const DEFAULT_BASE_URL = 'https://api.jup.ag/prediction/v1';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Snapshot of the most recently observed `x-ratelimit-*` response headers. `null` fields mean that header wasn't present on the response. */
export interface JupiterRateLimitInfo {
  remaining: number | null;
  current: number | null;
  /** Unix seconds. */
  reset: number | null;
}

/** On a 429, retried up to this many additional times (so up to `MAX_RETRIES + 1` attempts total) — a final failure after that is thrown, never swallowed. */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;

export class JupiterApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: JupiterErrorResponse | null;

  constructor(status: number, path: string, body: JupiterErrorResponse | null, message: string) {
    super(message);
    this.name = 'JupiterApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface JupiterPredictionClientOptions {
  /** Defaults to `https://api.jup.ag/prediction/v1`. */
  baseUrl?: string;
  /** Sent as `x-api-key`. Reads work keyless at low volume (see docs/jupiter-prediction-discovery.md §7.1) but a key is required for any real polling cadence. */
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

export class JupiterPredictionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRateLimitInfo: JupiterRateLimitInfo | null = null;

  constructor(options: JupiterPredictionClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Most recently observed `x-ratelimit-*` headers, from any endpoint — response metadata exposed as a side-channel rather than changing every method's return shape. `null` until the first request completes. */
  getLastRateLimitInfo(): JupiterRateLimitInfo | null {
    return this.lastRateLimitInfo;
  }

  /** Global recent-trades feed. No pagination params exist upstream — see docs/rest-api-capabilities.md §3.5. */
  async getTrades(): Promise<JupiterTrade[]> {
    const res = await this.request<JupiterTradesResponse>('/trades');
    return res.data;
  }

  /** Ranked wallets by realized PnL / volume / win rate, server-computed. */
  async getLeaderboards(
    params: {
      period?: JupiterLeaderboardPeriod;
      metric?: JupiterLeaderboardMetric;
      limit?: number;
    } = {},
  ): Promise<JupiterLeaderboardEntry[]> {
    const res = await this.request<JupiterLeaderboardsResponse>('/leaderboards', params);
    return res.data;
  }

  /** Single wallet aggregate: realized PnL, volume, prediction/win-loss counts. */
  async getProfile(ownerPubkey: string): Promise<JupiterProfile> {
    return this.request<JupiterProfile>(`/profiles/${encodeURIComponent(ownerPubkey)}`);
  }

  /**
   * Per-fill/lifecycle event log (v1). `ownerPubkey` is required upstream —
   * an unscoped call returns a `400` (confirmed live, see
   * docs/rest-api-capabilities.md §3.1). Genuinely paginated
   * (`{start, end, total, hasNext}`), unlike `/trades`.
   */
  async getHistory(params: {
    ownerPubkey: string;
    positionPubkey?: string;
    start?: number;
    end?: number;
  }): Promise<JupiterHistoryV1Response> {
    return this.request<JupiterHistoryV1Response>('/history', params);
  }

  /** Open/closed positions, optionally filtered by owner and/or market. */
  async getPositions(
    params: {
      ownerPubkey?: string;
      marketId?: string;
      start?: number;
      end?: number;
    } = {},
  ): Promise<JupiterPosition[]> {
    const res = await this.request<JupiterPositionsV1Response>('/positions', params);
    return res.data;
  }

  /** Single market lookup — no bulk `/markets` list endpoint is documented, only per-market. */
  async getMarket(marketId: string): Promise<JupiterMarket> {
    return this.request<JupiterMarket>(`/markets/${encodeURIComponent(marketId)}`);
  }

  private parseRateLimitHeaders(res: Response): JupiterRateLimitInfo | null {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const current = res.headers.get('x-ratelimit-current');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === null && current === null && reset === null) return null;
    return {
      remaining: remaining !== null ? Number(remaining) : null,
      current: current !== null ? Number(current) : null,
      reset: reset !== null ? Number(reset) : null,
    };
  }

  /**
   * `retry-after` (HTTP-standard, either delay-seconds or an HTTP-date) is
   * checked first when present — confirmed live (2026-07-06) that this
   * API does NOT actually send it, but it's the correct signal to prefer
   * if that ever changes. Falls back to `x-ratelimit-reset` (this API's
   * own header, confirmed always present on 429s), then to a small fixed
   * backoff if neither is usable.
   */
  private computeRetryDelayMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_BACKOFF_MS);
      }
      const dateMs = Date.parse(retryAfter);
      if (!Number.isNaN(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), MAX_BACKOFF_MS);
      }
    }

    if (this.lastRateLimitInfo?.reset) {
      const waitMs = this.lastRateLimitInfo.reset * 1000 - Date.now();
      if (waitMs > 0) return Math.min(waitMs, MAX_BACKOFF_MS);
    }

    return Math.min(BASE_BACKOFF_MS * (attempt + 1), MAX_BACKOFF_MS);
  }

  private async request<T>(path: string, query?: QueryParams): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;

        const res = await this.fetchImpl(url.toString(), { headers, signal: controller.signal });
        this.lastRateLimitInfo = this.parseRateLimitHeaders(res) ?? this.lastRateLimitInfo;

        const text = await res.text();
        const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;

        if (!res.ok) {
          const body = isJupiterErrorResponse(parsed) ? parsed : null;
          const error = new JupiterApiError(
            res.status,
            path,
            body,
            body?.message ?? `Jupiter Prediction API request failed: ${res.status} ${path}`,
          );

          if (res.status === 429 && attempt < MAX_RETRIES) {
            const delayMs = this.computeRetryDelayMs(res, attempt);
            console.warn(
              `[jupiter-client] 429 on ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — ` +
                `remaining=${this.lastRateLimitInfo?.remaining ?? '?'} ` +
                `reset=${this.lastRateLimitInfo?.reset ?? '?'} — retrying in ${delayMs}ms`,
            );
            attempt += 1;
            await sleep(delayMs);
            continue;
          }

          // Not a retryable 429, or retries exhausted — never swallowed.
          throw error;
        }

        return parsed as T;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

function isJupiterErrorResponse(value: unknown): value is JupiterErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'message' in value &&
    'request_id' in value
  );
}
