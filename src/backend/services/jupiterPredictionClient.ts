/**
 * Thin, typed read-only wrapper around the Jupiter Prediction REST API
 * (`api.jup.ag/prediction/v1` — the documented, sanctioned base URL per
 * `docs/jupiter-prediction-discovery.md` §2; `prediction-market-api.jup.ag`'s
 * `/api/v2/*` endpoints are deliberately NOT wired here, since research
 * flagged that host's support status as an open question — see
 * `docs/rest-api-capabilities.md` §1).
 *
 * This is a request-shaped wrapper only: no polling loop, no caching, no
 * retry/backoff, no persistence. That belongs to a future ingestion service
 * built on top of this client.
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

const DEFAULT_BASE_URL = 'https://api.jup.ag/prediction/v1';
const DEFAULT_TIMEOUT_MS = 10_000;

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

  constructor(options: JupiterPredictionClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private async request<T>(path: string, query?: QueryParams): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;

      const res = await this.fetchImpl(url.toString(), { headers, signal: controller.signal });
      const text = await res.text();
      const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;

      if (!res.ok) {
        const body = isJupiterErrorResponse(parsed) ? parsed : null;
        throw new JupiterApiError(
          res.status,
          path,
          body,
          body?.message ?? `Jupiter Prediction API request failed: ${res.status} ${path}`,
        );
      }

      return parsed as T;
    } finally {
      clearTimeout(timer);
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
