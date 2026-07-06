'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime, formatScore, formatUsd } from '../lib/format';
import { WalletLink, WalletLinks } from '../components/WalletLink';
import {
  SeverityBadge,
  TierBadge,
  type SignalSeverity,
  type WalletScoreTier,
} from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { RefreshBar } from '../components/RefreshBar';

/**
 * Same fallback/reasoning as `app/page.tsx` — Next's env-file loading is
 * scoped to `src/frontend`, so a repo-root `.env` isn't picked up here;
 * the default already matches local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

type LoadState = 'loading' | 'loaded' | 'error';

type SignalType = 'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';

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
              <td>{signal.eventTitle ?? signal.marketId ?? '—'}</td>
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
                <WalletLink pubkey={wallet.walletPubkey} />
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
            <tr key={market.marketId} title={market.marketId}>
              <td>{market.eventTitle ?? market.marketId}</td>
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
                <WalletLink pubkey={wallet.walletPubkey} />
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
              <td title={market.marketId}>{market.eventTitle ?? market.marketId}</td>
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

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

  const loadDashboard = useCallback((isInitial: boolean) => {
    if (isInitial) {
      setState('loading');
    } else {
      setIsRefreshing(true);
      setRefreshError(null);
    }

    const dashboardRequest = fetch(`${API_BASE_URL}/api/dashboard`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Dashboard request failed (HTTP ${response.status})`);
      }
      return (await response.json()) as DashboardResponse;
    });

    // A separate endpoint (`GET /api/trending/wallets`, Phase 4.1), fetched
    // alongside the dashboard's own request rather than added to the
    // dashboard's response — the trending card is still part of this one
    // page/refresh cycle, it just composes two independent API calls.
    const trendingRequest = fetch(`${API_BASE_URL}/api/trending/wallets`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Trending wallets request failed (HTTP ${response.status})`);
      }
      return (await response.json()) as TrendingWalletsResponse;
    });

    // Same reasoning as `trendingRequest` above — a separate endpoint
    // (`GET /api/trending/markets`, Phase 4.2), fetched alongside the
    // other two and folded into this one page's refresh cycle.
    const trendingMarketsRequest = fetch(`${API_BASE_URL}/api/trending/markets`).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(`Trending markets request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as TrendingMarketsResponse;
      },
    );

    return Promise.all([dashboardRequest, trendingRequest, trendingMarketsRequest])
      .then(([dashboardPayload, trendingPayload, trendingMarketsPayload]) => {
        if (!mountedRef.current) return;
        setData(dashboardPayload);
        setTrendingWallets(trendingPayload.wallets);
        setTrendingMarkets(trendingMarketsPayload.markets);
        setState('loaded');
        setLastUpdatedAt(new Date());
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Failed to load dashboard';
        // A failed *refresh* keeps whatever data is already on screen —
        // only a failed *initial* load has nothing to fall back to, so
        // only that case replaces the page with the error state.
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
  }, []);

  useEffect(() => {
    void loadDashboard(true);
  }, [loadDashboard]);

  return (
    <main>
      <h1>Smart Money Dashboard</h1>

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
                signals={data.signals}
                emptyMessage="No signals detected in this window."
              />
            </SectionCard>

            <SectionCard title="Top Smart Score Wallets">
              <WalletScoreTable
                wallets={data.topWallets}
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
              <TopMarketsTable markets={data.topMarkets} />
            </SectionCard>

            <SectionCard title="Active Smart Wallets">
              <WalletScoreTable
                wallets={data.activeSmartWallets}
                emptyMessage="No recently active wallets meet the smart-score bar."
              />
            </SectionCard>

            <SectionCard title="Trending Wallets">
              <TrendingWalletsTable wallets={trendingWallets} />
            </SectionCard>

            <SectionCard title="Trending Markets">
              <TrendingMarketsTable markets={trendingMarkets} />
            </SectionCard>
          </div>
        </>
      )}
    </main>
  );
}
