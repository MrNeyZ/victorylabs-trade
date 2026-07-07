'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { formatDateTime, formatScore, formatUsd } from '../../lib/format';
import {
  SeverityBadge,
  TierBadge,
  type SignalSeverity,
  type WalletScoreTier,
} from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { SectionCard } from '../../components/SectionCard';
import { RefreshBar } from '../../components/RefreshBar';
import { WalletLink, WalletLinks } from '../../components/WalletLink';
import { FavoriteButton } from '../../components/FavoriteButton';
import { useRealtimeTrades, type RealtimeTrade } from '../../lib/realtimeTrades';
import { useDebouncedCallback } from '../../lib/useDebouncedCallback';

/**
 * Same fallback/reasoning as every other page in this app — Next's
 * env-file loading is scoped to `src/frontend`, so a repo-root `.env`
 * isn't picked up here; the default already matches local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

/** Phase 5.5: how long to wait after the last live trade affecting this market before refetching — coalesces a burst into one refresh instead of one per trade. */
const LIVE_REFRESH_DEBOUNCE_MS = 3_000;

type LoadState = 'loading' | 'loaded' | 'error';
type SignalType = 'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';

/**
 * Every interface below is a hand-mirrored (and, where this page doesn't
 * render every field, deliberately trimmed) subset of the backend's
 * `GET /api/markets/:marketId` response
 * (`src/backend/api/routes/markets.ts`) — not imported directly, same
 * convention every other page in this app already follows.
 */
interface MarketActivitySummary {
  totalTrades: number;
  totalVolumeUsd: string;
  uniqueWallets: number;
  tradesLast24h: number;
  tradesLast7d: number;
  volumeLast24h: string;
  volumeLast7d: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

interface TrendingMarket {
  trendingScore: number;
  reason: string[];
  smartWallets: number;
  whaleSignalCount: number;
  consensusSignalCount: number;
}

interface Trade {
  id: string;
  ownerPubkey: string;
  eventTitle: string | null;
  marketTitle: string | null;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  amountUsd: string;
  priceUsd: string;
  upstreamTimestamp: string;
}

interface MarketWalletActivity {
  walletPubkey: string;
  tradeCount: number;
  volumeUsd: string;
}

interface MarketSmartWallet {
  walletPubkey: string;
  score: number;
  tier: WalletScoreTier;
}

interface PersistedSignal {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  walletPubkeys: string[];
  side: 'yes' | 'no' | null;
  amountUsd: string | null;
  occurredAt: string;
  explanation: string;
}

interface SideCounts {
  yes: number;
  no: number;
}

interface SideVolumes {
  yes: string;
  no: string;
}

interface MarketDetailResponse {
  marketId: string;
  eventTitle: string | null;
  activitySummary: MarketActivitySummary;
  trendingMarket: TrendingMarket | null;
  recentTrades: Trade[];
  topWalletsInMarket: MarketWalletActivity[];
  smartWalletsInMarket: MarketSmartWallet[];
  whaleSignals: PersistedSignal[];
  consensusSignals: PersistedSignal[];
  sideBreakdown: SideCounts;
  volumeBreakdown: SideVolumes;
}

function StatTable({ rows }: { rows: Array<[string, string | number]> }) {
  return (
    <table>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrendingMarketCard({ trending }: { trending: TrendingMarket | null }) {
  if (!trending) {
    return (
      <EmptyState message="Not currently trending — no recent activity in the trending window." />
    );
  }

  return (
    <>
      <p className="score-hero">
        <span className="score-value">{formatScore(trending.trendingScore)}</span>
      </p>
      <StatTable
        rows={[
          ['Smart Wallets', trending.smartWallets],
          ['Whale Signals', trending.whaleSignalCount],
          ['Consensus Signals', trending.consensusSignalCount],
        ]}
      />
      {trending.reason.length > 0 && (
        <ul className="explanation-list">
          {trending.reason.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function ActivitySummaryCard({ summary }: { summary: MarketActivitySummary }) {
  return (
    <StatTable
      rows={[
        ['Total Trades', summary.totalTrades],
        ['Total Volume', formatUsd(summary.totalVolumeUsd)],
        ['Unique Wallets', summary.uniqueWallets],
        ['Trades (24h)', summary.tradesLast24h],
        ['Trades (7d)', summary.tradesLast7d],
        ['Volume (24h)', formatUsd(summary.volumeLast24h)],
        ['Volume (7d)', formatUsd(summary.volumeLast7d)],
        ['First Seen', formatDateTime(summary.firstSeenAt)],
        ['Last Seen', formatDateTime(summary.lastSeenAt)],
      ]}
    />
  );
}

function SideBreakdownCard({
  sideBreakdown,
  volumeBreakdown,
}: {
  sideBreakdown: SideCounts;
  volumeBreakdown: SideVolumes;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Side</th>
          <th>Trades</th>
          <th>Volume</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Yes</td>
          <td>{sideBreakdown.yes}</td>
          <td>{formatUsd(volumeBreakdown.yes)}</td>
        </tr>
        <tr>
          <td>No</td>
          <td>{sideBreakdown.no}</td>
          <td>{formatUsd(volumeBreakdown.no)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function TopWalletsTable({ wallets }: { wallets: MarketWalletActivity[] }) {
  if (wallets.length === 0) return <EmptyState message="No wallets have traded this market yet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Wallet</th>
            <th>Trades</th>
            <th>Volume</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet, index) => (
            <tr key={wallet.walletPubkey}>
              <td>{index + 1}</td>
              <td>
                <WalletLink pubkey={wallet.walletPubkey} />
              </td>
              <td>{wallet.tradeCount}</td>
              <td>{formatUsd(wallet.volumeUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SmartWalletsTable({ wallets }: { wallets: MarketSmartWallet[] }) {
  if (wallets.length === 0) {
    return (
      <EmptyState message="No smart-scored wallets (Smart Score >= 35) trading this market yet." />
    );
  }

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
            <tr key={wallet.walletPubkey}>
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

function RecentTradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <EmptyState message="No recent trades for this market." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Action</th>
            <th>Side</th>
            <th>Amount</th>
            <th>Price</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.id}>
              <td>
                <WalletLink pubkey={trade.ownerPubkey} />
              </td>
              <td className={`action-${trade.action}`}>{trade.action}</td>
              <td>{trade.side}</td>
              <td>{formatUsd(trade.amountUsd)}</td>
              <td>{formatUsd(trade.priceUsd)}</td>
              <td>{formatDateTime(trade.upstreamTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
            <th>Severity</th>
            <th>Wallet(s)</th>
            <th>Side</th>
            <th>Amount</th>
            <th>Occurred</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((signal) => (
            <tr key={signal.id} title={signal.explanation}>
              <td>
                <SeverityBadge severity={signal.severity} />
              </td>
              <td title={signal.walletPubkeys.join(', ')}>
                <WalletLinks pubkeys={signal.walletPubkeys} />
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

export default function MarketDetailPage() {
  const params = useParams<{ marketId: string }>();
  const marketId = params.marketId;

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<MarketDetailResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Phase 5.5: this page previously had no "refresh without blanking the
  // page" path at all (no manual refresh button, no live updates) — added
  // now, same `isRefreshing`/`refreshError`/`lastUpdatedAt` shape
  // `wallet/[walletPubkey]/page.tsx`/`dashboard/page.tsx` already use, so
  // a live-triggered refetch (or a manual Refresh click) keeps whatever
  // is already on screen if it fails, instead of the page going blank.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMarket = useCallback(
    (isInitial: boolean) => {
      if (!marketId) return Promise.resolve();

      if (isInitial) {
        setState('loading');
      } else {
        setIsRefreshing(true);
        setRefreshError(null);
      }

      return fetch(`${API_BASE_URL}/api/markets/${encodeURIComponent(marketId)}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Market request failed (HTTP ${response.status})`);
          }
          return (await response.json()) as MarketDetailResponse;
        })
        .then((payload) => {
          if (!mountedRef.current) return;
          setData(payload);
          setState('loaded');
          setLastUpdatedAt(new Date());
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          const message = err instanceof Error ? err.message : 'Failed to load market';
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
    [marketId],
  );

  // Re-runs (as a fresh "initial" load, not a "refresh") whenever the
  // URL's market id itself changes — a different market is a different
  // page, not a refresh of the same one, so old data is cleared, not kept.
  useEffect(() => {
    void loadMarket(true);
  }, [loadMarket]);

  // Phase 5.5: live refresh. Recent trades/activity/top wallets/whale &
  // consensus signals are all one bundle (`GET /api/markets/:marketId`),
  // so a matching trade just triggers the same `loadMarket(false)` a
  // manual refresh would — debounced so a burst of this market's trades
  // coalesces into one refetch instead of one per trade.
  const scheduleLiveRefresh = useDebouncedCallback(() => {
    void loadMarket(false);
  }, LIVE_REFRESH_DEBOUNCE_MS);

  const handleRealtimeTrade = useCallback(
    (trade: RealtimeTrade) => {
      if (trade.marketId === marketId) scheduleLiveRefresh();
    },
    [marketId, scheduleLiveRefresh],
  );
  useRealtimeTrades(handleRealtimeTrade);

  // Same "open identifier space" convention the wallet detail page uses
  // (see its own doc comment) — a syntactically valid marketId with no
  // ingested trades still returns 200 with everything zeroed/empty, not
  // a 404. This is the frontend's own derived signal for "unknown market".
  const isUnknownMarket = data !== null && data.activitySummary.totalTrades === 0;

  return (
    <main>
      <h1>
        Market <FavoriteButton type="market" id={marketId} />
      </h1>
      <p className="market-subtitle">
        {data?.eventTitle ?? marketId}
        {data?.eventTitle && <> ({marketId})</>}
      </p>

      {state === 'loading' && <p className="loading-state">Loading market…</p>}

      {state === 'error' && (
        <p className="error-state">
          Couldn&apos;t load this market{errorMessage ? `: ${errorMessage}` : '.'}
        </p>
      )}

      {state === 'loaded' && data && (
        <>
          <RefreshBar
            metaText={`Last updated ${formatDateTime(lastUpdatedAt?.toISOString() ?? null)}`}
            isRefreshing={isRefreshing}
            onRefresh={() => void loadMarket(false)}
            refreshError={refreshError}
          />

          {isUnknownMarket && (
            <EmptyState message="No data found for this market yet — it may not have been traded (or hasn't been ingested) within this project's coverage." />
          )}

          <div className="dashboard-grid">
            <SectionCard title="Trending Market">
              <TrendingMarketCard trending={data.trendingMarket} />
            </SectionCard>

            <SectionCard title="Trade Activity">
              <ActivitySummaryCard summary={data.activitySummary} />
            </SectionCard>

            <SectionCard title="Yes / No Breakdown">
              <SideBreakdownCard
                sideBreakdown={data.sideBreakdown}
                volumeBreakdown={data.volumeBreakdown}
              />
            </SectionCard>

            <SectionCard title="Top Wallets">
              <TopWalletsTable wallets={data.topWalletsInMarket} />
            </SectionCard>

            <SectionCard title="Smart Wallets">
              <SmartWalletsTable wallets={data.smartWalletsInMarket} />
            </SectionCard>

            <SectionCard title="Recent Trades">
              <RecentTradesTable trades={data.recentTrades} />
            </SectionCard>

            <SectionCard title="Whale Signals">
              <SignalsTable
                signals={data.whaleSignals}
                emptyMessage="No whale-trade signals for this market yet."
              />
            </SectionCard>

            <SectionCard title="Consensus Signals">
              <SignalsTable
                signals={data.consensusSignals}
                emptyMessage="No market-consensus signals for this market yet."
              />
            </SectionCard>
          </div>
        </>
      )}
    </main>
  );
}
