'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime, formatScore, formatUsd } from '../lib/format';
import { WalletLink, WalletLinks } from '../components/WalletLink';
import { MarketLink } from '../components/MarketLink';
import {
  SeverityBadge,
  TierBadge,
  type SignalSeverity,
  type WalletScoreTier,
} from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { RefreshBar } from '../components/RefreshBar';
import { FilterBar } from '../components/FilterBar';
import type { SignalType } from '../lib/notifications';
import { applySortDirection, useDashboardFilters } from '../lib/dashboardFilters';
import { useRealtimeTrades } from '../lib/realtimeTrades';
import { useThrottledCallback } from '../lib/useThrottledCallback';

/**
 * Same fallback/reasoning as `app/page.tsx` — Next's env-file loading is
 * scoped to `src/frontend`, so a repo-root `.env` isn't picked up here;
 * the default already matches local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

/** Matches `/api/dashboard`'s own `DEFAULT_LIMIT` — keeps the "Latest Signals" row count identical to before Phase 5.4, when that table read `DashboardResponse.signals` instead of its own `/api/signals/recent` request. */
const RECENT_SIGNALS_LIMIT = 20;

/**
 * Phase 5.5 follow-up: the dashboard is a terminal-wide aggregate view,
 * not scoped to one wallet/market like the detail pages — it doesn't
 * need to refresh on their ~3s debounce. Throttled to at most once per
 * 15s instead (see `../lib/useThrottledCallback.ts`), even under a
 * sustained burst of trades.
 */
const LIVE_REFRESH_THROTTLE_MS = 15_000;

type LoadState = 'loading' | 'loaded' | 'error';

interface SignalScoreContextEntry {
  walletPubkey: string;
  score: number;
  tier: WalletScoreTier;
}

/** Mirrors the backend's `PersistedSignal` (`src/backend/db/repositories/signalsRepository.ts`) — not imported directly, since the frontend only ever consumes the backend's JSON, never its TypeScript types (see README §11). */
interface PersistedSignal {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  walletPubkeys: string[];
  marketId: string | null;
  side: 'yes' | 'no' | null;
  eventTitle: string | null;
  amountUsd: string | null;
  scoreContext: SignalScoreContextEntry[];
  occurredAt: string;
  explanation: string;
}

/** Mirrors `WalletScoreSnapshotResult` — `stats` is deliberately omitted, this page doesn't render it. */
interface WalletScoreSnapshot {
  walletPubkey: string;
  snapshotAt: string;
  score: number;
  tier: WalletScoreTier;
  explanations: string[];
}

interface TopActiveMarket {
  marketId: string;
  eventTitle: string | null;
  tradeCount: number;
  volumeUsd: string;
  lastTradeAt: string;
}

interface DashboardResponse {
  generatedAt: string;
  lookbackMinutes: number;
  signals: PersistedSignal[];
  topWallets: WalletScoreSnapshot[];
  whaleTrades: PersistedSignal[];
  consensus: PersistedSignal[];
  topMarkets: TopActiveMarket[];
  activeSmartWallets: WalletScoreSnapshot[];
}

/** Mirrors the backend's `TrendingWallet` (`src/backend/analytics/trending/computeTrendingScore.ts`) — from a separate endpoint (`GET /api/trending/wallets`, Phase 4.1), fetched alongside `GET /api/dashboard` and folded into this page's single refresh cycle (see `loadDashboard` below). */
interface TrendingWallet {
  walletPubkey: string;
  trendingScore: number;
  reason: string[];
  latestSmartScore: number | null;
  recentTradeCount: number;
  recentVolumeUsd: string;
  lastActivityAt: string;
}

interface TrendingWalletsResponse {
  lookbackMinutes: number;
  limit: number;
  wallets: TrendingWallet[];
}

/** Mirrors the backend's `TrendingMarket` (`src/backend/analytics/trendingMarkets/computeTrendingMarketScore.ts`) — from a separate endpoint (`GET /api/trending/markets`, Phase 4.2), fetched the same way `TrendingWallet` is. */
interface TrendingMarket {
  marketId: string;
  eventTitle: string | null;
  trendingScore: number;
  reason: string[];
  recentTradeCount: number;
  recentVolumeUsd: string;
  uniqueWallets: number;
  smartWallets: number;
  whaleSignalCount: number;
  consensusSignalCount: number;
  lastActivityAt: string;
}

interface TrendingMarketsResponse {
  lookbackMinutes: number;
  limit: number;
  markets: TrendingMarket[];
}

/** Mirrors `GET /api/signals/recent`'s default (`source=persisted`) response shape — Phase 5.4 is the first thing on this page to call this endpoint directly (previously "Latest Signals" only ever read `DashboardResponse.signals`, which isn't itself filterable by type without a second `/api/dashboard` round trip). */
interface RecentSignalsResponse {
  source: 'persisted';
  lookbackMinutes: number;
  limit: number;
  signals: PersistedSignal[];
}

function SignalsTable({
  signals,
  emptyMessage,
}: {
  signals: PersistedSignal[];
  emptyMessage: string;
}) {
  if (signals.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Severity</th>
            <th>Wallet(s)</th>
            <th>Market / Event</th>
            <th>Side</th>
            <th>Amount</th>
            <th>Occurred</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((signal) => (
            <tr key={signal.id} title={signal.explanation}>
              <td>{signal.type}</td>
              <td>
                <SeverityBadge severity={signal.severity} />
              </td>
              <td title={signal.walletPubkeys.join(', ')}>
                <WalletLinks pubkeys={signal.walletPubkeys} />
              </td>
              <td>
                {signal.marketId ? (
                  <MarketLink marketId={signal.marketId} label={signal.eventTitle} />
                ) : (
                  '—'
                )}
              </td>
              <td>{signal.side ?? '—'}</td>
              <td>{formatUsd(signal.amountUsd)}</td>
              <td>{formatDateTime(signal.occurredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WalletScoreTable({
  wallets,
  emptyMessage,
}: {
  wallets: WalletScoreSnapshot[];
  emptyMessage: string;
}) {
  if (wallets.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Wallet</th>
            <th>Score</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet, index) => (
            <tr key={wallet.walletPubkey} title={wallet.explanations.join(' ')}>
              <td>{index + 1}</td>
              <td>
                <WalletLink pubkey={wallet.walletPubkey} showFavorite />
              </td>
              <td>{formatScore(wallet.score)}</td>
              <td>
                <TierBadge tier={wallet.tier} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopMarketsTable({ markets }: { markets: TopActiveMarket[] }) {
  if (markets.length === 0) return <EmptyState message="No market activity in this window." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Market / Event</th>
            <th>Trades</th>
            <th>Volume</th>
            <th>Last Trade</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <tr key={market.marketId}>
              <td>
                <MarketLink marketId={market.marketId} label={market.eventTitle} showFavorite />
              </td>
              <td>{market.tradeCount}</td>
              <td>{formatUsd(market.volumeUsd)}</td>
              <td>{formatDateTime(market.lastTradeAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendingWalletsTable({ wallets }: { wallets: TrendingWallet[] }) {
  if (wallets.length === 0) {
    return <EmptyState message="No trending wallets in this window." />;
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Wallet</th>
            <th>Trending Score</th>
            <th>Smart Score</th>
            <th>Recent Trades</th>
            <th>Recent Volume</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet, index) => (
            <tr key={wallet.walletPubkey} title={wallet.reason.join(' ')}>
              <td>{index + 1}</td>
              <td>
                <WalletLink pubkey={wallet.walletPubkey} showFavorite />
              </td>
              <td>{formatScore(wallet.trendingScore)}</td>
              <td>
                {wallet.latestSmartScore === null ? '—' : formatScore(wallet.latestSmartScore)}
              </td>
              <td>{wallet.recentTradeCount}</td>
              <td>{formatUsd(wallet.recentVolumeUsd)}</td>
              <td>{formatDateTime(wallet.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendingMarketsTable({ markets }: { markets: TrendingMarket[] }) {
  if (markets.length === 0) {
    return <EmptyState message="No trending markets in this window." />;
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Market / Event</th>
            <th>Trending Score</th>
            <th>Trades</th>
            <th>Volume</th>
            <th>Wallets</th>
            <th>Smart Wallets</th>
            <th>Whale</th>
            <th>Consensus</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market, index) => (
            <tr key={market.marketId} title={market.reason.join(' ')}>
              <td>{index + 1}</td>
              <td>
                <MarketLink marketId={market.marketId} label={market.eventTitle} showFavorite />
              </td>
              <td>{formatScore(market.trendingScore)}</td>
              <td>{market.recentTradeCount}</td>
              <td>{formatUsd(market.recentVolumeUsd)}</td>
              <td>{market.uniqueWallets}</td>
              <td>{market.smartWallets}</td>
              <td>{market.whaleSignalCount}</td>
              <td>{market.consensusSignalCount}</td>
              <td>{formatDateTime(market.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardPage() {
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [trendingWallets, setTrendingWallets] = useState<TrendingWallet[]>([]);
  const [trendingMarkets, setTrendingMarkets] = useState<TrendingMarket[]>([]);
  const [recentSignals, setRecentSignals] = useState<PersistedSignal[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const { filters, hydrated, updateFilters, resetFilters } = useDashboardFilters();

  // Guards every setState below against firing after unmount — shared by
  // both the mount-time load and the refresh button's click handler, so
  // it has to be a ref (not the old per-effect `cancelled` local) since
  // both call sites share this one function.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const lookbackMinutes = filters.lookbackMinutes;

  const loadDashboard = useCallback(
    (isInitial: boolean) => {
      if (isInitial) {
        setState('loading');
      } else {
        setIsRefreshing(true);
        setRefreshError(null);
      }

      const lookbackQuery = `lookbackMinutes=${lookbackMinutes}`;

      const dashboardRequest = fetch(`${API_BASE_URL}/api/dashboard?${lookbackQuery}`).then(
        async (response) => {
          if (!response.ok) {
            throw new Error(`Dashboard request failed (HTTP ${response.status})`);
          }
          return (await response.json()) as DashboardResponse;
        },
      );

      // A separate endpoint (`GET /api/trending/wallets`, Phase 4.1), fetched
      // alongside the dashboard's own request rather than added to the
      // dashboard's response — the trending card is still part of this one
      // page/refresh cycle, it just composes two independent API calls.
      const trendingRequest = fetch(`${API_BASE_URL}/api/trending/wallets?${lookbackQuery}`).then(
        async (response) => {
          if (!response.ok) {
            throw new Error(`Trending wallets request failed (HTTP ${response.status})`);
          }
          return (await response.json()) as TrendingWalletsResponse;
        },
      );

      // Same reasoning as `trendingRequest` above — a separate endpoint
      // (`GET /api/trending/markets`, Phase 4.2), fetched alongside the
      // other two and folded into this one page's refresh cycle.
      const trendingMarketsRequest = fetch(
        `${API_BASE_URL}/api/trending/markets?${lookbackQuery}`,
      ).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Trending markets request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as TrendingMarketsResponse;
      });

      // `GET /api/signals/recent` (persisted, Phase 3.5/3.6) — Phase 5.4
      // switches "Latest Signals" to this endpoint instead of
      // `DashboardResponse.signals` so the signal-type filter has a
      // dedicated, independently-lookback-scoped list to filter client-side
      // (see `filteredRecentSignals` below). `limit` is fixed at
      // `RECENT_SIGNALS_LIMIT` to match `/api/dashboard`'s own default, so
      // the row count is unchanged from before this phase.
      const recentSignalsRequest = fetch(
        `${API_BASE_URL}/api/signals/recent?${lookbackQuery}&limit=${RECENT_SIGNALS_LIMIT}`,
      ).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Recent signals request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as RecentSignalsResponse;
      });

      return Promise.all([
        dashboardRequest,
        trendingRequest,
        trendingMarketsRequest,
        recentSignalsRequest,
      ])
        .then(([dashboardPayload, trendingPayload, trendingMarketsPayload, recentSignalsPayload]) => {
          if (!mountedRef.current) return;
          setData(dashboardPayload);
          setTrendingWallets(trendingPayload.wallets);
          setTrendingMarkets(trendingMarketsPayload.markets);
          setRecentSignals(recentSignalsPayload.signals);
          setState('loaded');
          setLastUpdatedAt(new Date());
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          const message = err instanceof Error ? err.message : 'Failed to load dashboard';
          // A failed *refresh* (including one triggered by a lookback
          // change) keeps whatever data is already on screen — only a
          // failed *initial* load has nothing to fall back to, so only
          // that case replaces the page with the error state.
          if (isInitial) {
            setErrorMessage(message);
            setState('error');
          } else {
            setRefreshError(message);
          }
        })
        .finally(() => {
          if (!mountedRef.current) return;
          if (!isInitial) setIsRefreshing(false);
        });
    },
    [lookbackMinutes],
  );

  // Waits on `hydrated` so the very first fetch already uses whatever
  // lookback was persisted in `localStorage`, instead of firing once with
  // the default and again moments later once the real value loads. Every
  // subsequent `lookbackMinutes` change (dropdown or `resetFilters`) is a
  // *refresh*, not a fresh initial load — same "preserve last-good data
  // on failure" path a manual Refresh click uses.
  const isFirstLoadRef = useRef(true);
  useEffect(() => {
    if (!hydrated) return;
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false;
      void loadDashboard(true);
      return;
    }
    void loadDashboard(false);
  }, [hydrated, loadDashboard]);

  // Phase 5.5: live refresh. The dashboard's own sections (signals, top
  // wallets, trending wallets/markets, top markets) are all terminal-wide
  // aggregates, not scoped to one wallet/market — so *any* trade on the
  // shared stream is a reason to go re-check them, unlike the wallet/
  // market detail pages below which only care about trades matching their
  // own id. Throttled (not debounced) to at most once per
  // `LIVE_REFRESH_THROTTLE_MS`: a sustained burst of trades still only
  // refreshes this aggregate view every 15s, not after every quiet gap.
  // Reuses `loadDashboard(false)` either way — the exact same "keep
  // last-good data, show Updating…" path the Refresh button and lookback
  // changes already use, so a live-triggered refresh can't blank the page
  // or reset scroll position (it's a plain state update, not a
  // navigation).
  const scheduleLiveRefresh = useThrottledCallback(() => {
    if (!hydrated) return;
    void loadDashboard(false);
  }, LIVE_REFRESH_THROTTLE_MS);
  useRealtimeTrades(scheduleLiveRefresh);

  // Everything below is a client-side re-derivation of already-fetched
  // data — none of it triggers a request. `signalType`/`minSmartScore`
  // filtering and `sortDirection` only touch the sections named in this
  // phase's brief ("min score affects smart wallet sections"); Whale
  // Trades/Market Consensus stay type-locked and time-ordered as before,
  // and market sections have no per-row Smart Score to filter by.
  const filteredRecentSignals = recentSignals.filter(
    (signal) => filters.signalType === 'all' || signal.type === filters.signalType,
  );

  const filteredTopWallets = data
    ? applySortDirection(
        data.topWallets.filter((wallet) => wallet.score >= filters.minSmartScore),
        filters.sortDirection,
      )
    : [];

  const filteredActiveSmartWallets = data
    ? applySortDirection(
        data.activeSmartWallets.filter((wallet) => wallet.score >= filters.minSmartScore),
        filters.sortDirection,
      )
    : [];

  const filteredTrendingWallets = applySortDirection(
    trendingWallets.filter(
      (wallet) =>
        filters.minSmartScore <= 0 ||
        (wallet.latestSmartScore !== null && wallet.latestSmartScore >= filters.minSmartScore),
    ),
    filters.sortDirection,
  );

  const sortedTopMarkets = data ? applySortDirection(data.topMarkets, filters.sortDirection) : [];
  const sortedTrendingMarkets = applySortDirection(trendingMarkets, filters.sortDirection);

  return (
    <main>
      <h1>Smart Money Dashboard</h1>

      <FilterBar
        filters={filters}
        isUpdating={isRefreshing}
        onChange={updateFilters}
        onReset={resetFilters}
      />

      {state === 'loading' && <p className="loading-state">Loading dashboard…</p>}

      {state === 'error' && (
        <p className="error-state">
          Couldn&apos;t load the dashboard{errorMessage ? `: ${errorMessage}` : '.'}
        </p>
      )}

      {state === 'loaded' && data && (
        <>
          <RefreshBar
            metaText={`Last updated ${formatDateTime(lastUpdatedAt?.toISOString() ?? null)} · showing last ${data.lookbackMinutes} minute(s)`}
            isRefreshing={isRefreshing}
            onRefresh={() => void loadDashboard(false)}
            refreshError={refreshError}
          />

          <div className="dashboard-grid">
            <SectionCard title="Latest Signals">
              <SignalsTable
                signals={filteredRecentSignals}
                emptyMessage="No signals detected in this window."
              />
            </SectionCard>

            <SectionCard title="Top Smart Score Wallets">
              <WalletScoreTable
                wallets={filteredTopWallets}
                emptyMessage="No scored wallets yet — run analytics:scores."
              />
            </SectionCard>

            <SectionCard title="Whale Trades">
              <SignalsTable
                signals={data.whaleTrades}
                emptyMessage="No whale trades in this window."
              />
            </SectionCard>

            <SectionCard title="Market Consensus">
              <SignalsTable
                signals={data.consensus}
                emptyMessage="No consensus signals in this window."
              />
            </SectionCard>

            <SectionCard title="Top Active Markets">
              <TopMarketsTable markets={sortedTopMarkets} />
            </SectionCard>

            <SectionCard title="Active Smart Wallets">
              <WalletScoreTable
                wallets={filteredActiveSmartWallets}
                emptyMessage="No recently active wallets meet the smart-score bar."
              />
            </SectionCard>

            <SectionCard title="Trending Wallets">
              <TrendingWalletsTable wallets={filteredTrendingWallets} />
            </SectionCard>

            <SectionCard title="Trending Markets">
              <TrendingMarketsTable markets={sortedTrendingMarkets} />
            </SectionCard>
          </div>
        </>
      )}
    </main>
  );
}
