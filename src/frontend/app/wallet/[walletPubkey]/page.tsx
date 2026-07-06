'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

/**
 * Same fallback/reasoning as `app/page.tsx`/`app/dashboard/page.tsx` —
 * Next's env-file loading is scoped to `src/frontend`, so a repo-root
 * `.env` isn't picked up here; the default already matches local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

type LoadState = 'loading' | 'loaded' | 'error';
type WalletScoreTier = 'elite' | 'strong' | 'watch' | 'weak' | 'unknown';

/**
 * Every interface below is a hand-mirrored (and, where this page doesn't
 * render every field, deliberately trimmed) subset of the backend's
 * `GET /api/wallets/:walletPubkey` response
 * (`src/backend/api/routes/wallets.ts`) — not imported directly, same
 * convention `app/page.tsx`/`app/dashboard/page.tsx` already follow (the
 * frontend only ever consumes the backend's JSON, never its TypeScript
 * types).
 */
interface WalletProfile {
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: number;
  correctPredictions: number;
  wrongPredictions: number;
}

interface Position {
  positionPubkey: string;
  marketId: string;
  sideLabel: 'Up' | 'Down' | null;
  valueUsd: string | null;
  pnlUsd: string | null;
  lifecycleStatus: 'open' | 'resolving' | 'settled' | null;
  openedAt: string | null;
}

interface Trade {
  id: string;
  marketId: string;
  eventTitle: string | null;
  marketTitle: string | null;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  amountUsd: string;
  priceUsd: string;
  upstreamTimestamp: string;
}

interface HistoryEvent {
  id: string;
  marketId: string | null;
  eventTitle: string | null;
  action: 'buy' | 'sell' | null;
  side: 'yes' | 'no' | null;
  amountUsd: string | null;
  price: string | null;
  realizedPnlUsd: string | null;
  upstreamTimestamp: string | null;
}

interface WalletStats {
  totalTrades: number;
  totalMarkets: number;
  currentOpenPositions: number;
  closedPositions: number;
  totalVolumeUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;
  averageEntryPrice: string | null;
  averageExitPrice: string | null;
  averageHoldTimeSeconds: number | null;
  firstTrade: string | null;
  lastTrade: string | null;
  activeDays: number;
  usedProfileFallbackFor: string[];
}

interface ActivitySummary {
  tradesLast24h: number;
  tradesLast7d: number;
  volumeLast24h: string;
  volumeLast7d: string;
  activeMarkets: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

interface MarketBreakdownEntry {
  marketId: string;
  eventTitle: string | null;
  totalTrades: number;
  volumeUsd: string;
  realizedPnlUsd: string | null;
  currentPositionUsd: string | null;
  lastActivityAt: string | null;
}

interface WalletScoreComponents {
  profitability: number;
  consistency: number;
  activity: number;
  recency: number;
  sampleSize: number;
}

interface WalletScoreSnapshot {
  snapshotAt: string;
  score: number;
  tier: WalletScoreTier;
  components: WalletScoreComponents;
  explanations: string[];
}

interface WalletDetailResponse {
  walletPubkey: string;
  profile: WalletProfile | null;
  positions: Position[];
  recentTrades: Trade[];
  recentHistory: HistoryEvent[];
  stats: WalletStats;
  latestSmartScore: WalletScoreSnapshot | null;
  smartScoreHistory: WalletScoreSnapshot[];
  marketBreakdown: MarketBreakdownEntry[];
  activitySummary: ActivitySummary;
}

function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : value;
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function TierBadge({ tier }: { tier: WalletScoreTier }) {
  return <span className={`badge tier-${tier}`}>{tier}</span>;
}

function EmptyState({ message }: { message: string }) {
  return <p className="empty-state">{message}</p>;
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

function SmartScoreCard({ score }: { score: WalletScoreSnapshot | null }) {
  if (!score) {
    return <EmptyState message="Not yet scored — run analytics:scores." />;
  }

  return (
    <>
      <p className="score-hero">
        <span className="score-value">{score.score}</span>
        <TierBadge tier={score.tier} />
      </p>
      <StatTable
        rows={[
          ['Profitability', score.components.profitability],
          ['Consistency', score.components.consistency],
          ['Activity', score.components.activity],
          ['Recency', score.components.recency],
          ['Sample Size', score.components.sampleSize],
          ['As Of', formatTime(score.snapshotAt)],
        ]}
      />
      {score.explanations.length > 0 && (
        <ul className="explanation-list">
          {score.explanations.map((explanation) => (
            <li key={explanation}>{explanation}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function WalletStatsCard({ stats }: { stats: WalletStats }) {
  return (
    <>
      <StatTable
        rows={[
          ['Total Trades', stats.totalTrades],
          ['Total Markets', stats.totalMarkets],
          ['Open Positions', stats.currentOpenPositions],
          ['Closed Positions', stats.closedPositions],
          ['Total Volume', formatUsd(stats.totalVolumeUsd)],
          ['Realized PnL', formatUsd(stats.realizedPnlUsd)],
          ['Unrealized PnL', formatUsd(stats.unrealizedPnlUsd)],
          ['Avg Entry Price', formatUsd(stats.averageEntryPrice)],
          ['Avg Exit Price', formatUsd(stats.averageExitPrice)],
          ['Avg Hold Time', formatDuration(stats.averageHoldTimeSeconds)],
          ['First Trade', formatTime(stats.firstTrade)],
          ['Last Trade', formatTime(stats.lastTrade)],
          ['Active Days', stats.activeDays],
        ]}
      />
      {stats.usedProfileFallbackFor.length > 0 && (
        <p className="card-footnote">
          {stats.usedProfileFallbackFor.join(', ')} sourced from Jupiter&apos;s own profile — no own
          trade/history data existed to reconstruct it.
        </p>
      )}
    </>
  );
}

function ActivitySummaryCard({ summary }: { summary: ActivitySummary }) {
  return (
    <StatTable
      rows={[
        ['Trades (24h)', summary.tradesLast24h],
        ['Trades (7d)', summary.tradesLast7d],
        ['Volume (24h)', formatUsd(summary.volumeLast24h)],
        ['Volume (7d)', formatUsd(summary.volumeLast7d)],
        ['Active Markets', summary.activeMarkets],
        ['First Seen', formatTime(summary.firstSeenAt)],
        ['Last Seen', formatTime(summary.lastSeenAt)],
      ]}
    />
  );
}

function MarketBreakdownTable({ markets }: { markets: MarketBreakdownEntry[] }) {
  if (markets.length === 0) return <EmptyState message="No market activity for this wallet yet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Market / Event</th>
            <th>Trades</th>
            <th>Volume</th>
            <th>Realized PnL</th>
            <th>Position Value</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <tr key={market.marketId} title={market.marketId}>
              <td>{market.eventTitle ?? market.marketId}</td>
              <td>{market.totalTrades}</td>
              <td>{formatUsd(market.volumeUsd)}</td>
              <td>{formatUsd(market.realizedPnlUsd)}</td>
              <td>{formatUsd(market.currentPositionUsd)}</td>
              <td>{formatTime(market.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0)
    return <EmptyState message="No positions ingested for this wallet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th>Value</th>
            <th>PnL</th>
            <th>Status</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.positionPubkey} title={position.marketId}>
              <td>{position.marketId}</td>
              <td>{position.sideLabel ?? '—'}</td>
              <td>{formatUsd(position.valueUsd)}</td>
              <td>{formatUsd(position.pnlUsd)}</td>
              <td>{position.lifecycleStatus ?? '—'}</td>
              <td>{formatTime(position.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentTradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <EmptyState message="No recent trades for this wallet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Market / Event</th>
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
              <td>{trade.eventTitle ?? trade.marketTitle ?? trade.marketId}</td>
              <td className={`action-${trade.action}`}>{trade.action}</td>
              <td>{trade.side}</td>
              <td>{formatUsd(trade.amountUsd)}</td>
              <td>{formatUsd(trade.priceUsd)}</td>
              <td>{formatTime(trade.upstreamTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentHistoryTable({ events }: { events: HistoryEvent[] }) {
  if (events.length === 0)
    return <EmptyState message="No history events ingested for this wallet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Market / Event</th>
            <th>Action</th>
            <th>Side</th>
            <th>Amount</th>
            <th>Price</th>
            <th>Realized PnL</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.eventTitle ?? event.marketId ?? '—'}</td>
              <td>{event.action ?? '—'}</td>
              <td>{event.side ?? '—'}</td>
              <td>{formatUsd(event.amountUsd)}</td>
              <td>{formatUsd(event.price)}</td>
              <td>{formatUsd(event.realizedPnlUsd)}</td>
              <td>{formatTime(event.upstreamTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScoreHistoryTable({ history }: { history: WalletScoreSnapshot[] }) {
  if (history.length === 0) return <EmptyState message="No score history yet." />;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Snapshot</th>
            <th>Score</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {history.map((snapshot) => (
            <tr key={snapshot.snapshotAt}>
              <td>{formatTime(snapshot.snapshotAt)}</td>
              <td>{snapshot.score}</td>
              <td>
                <TierBadge tier={snapshot.tier} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function WalletDetailPage() {
  const params = useParams<{ walletPubkey: string }>();
  const walletPubkey = params.walletPubkey;

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<WalletDetailResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!walletPubkey) return;

    let cancelled = false;
    setState('loading');

    fetch(`${API_BASE_URL}/api/wallets/${encodeURIComponent(walletPubkey)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Wallet request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as WalletDetailResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setState('loaded');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load wallet');
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [walletPubkey]);

  // A syntactically valid pubkey with no ingested data anywhere still
  // returns 200 with everything zeroed/empty (see wallets.ts's own doc
  // comment) — not a 404. This is the frontend's own signal for "unknown
  // wallet", derived from that same response, not a distinct API error.
  const isUnknownWallet =
    data !== null &&
    data.profile === null &&
    data.positions.length === 0 &&
    data.recentTrades.length === 0 &&
    data.recentHistory.length === 0 &&
    data.latestSmartScore === null;

  return (
    <main>
      <h1>Wallet</h1>
      <p className="wallet-pubkey">{walletPubkey}</p>

      {state === 'loading' && <p className="empty-state">Loading wallet…</p>}

      {state === 'error' && (
        <p className="error-state">
          Couldn&apos;t load this wallet{errorMessage ? `: ${errorMessage}` : '.'}
        </p>
      )}

      {state === 'loaded' && data && (
        <>
          {isUnknownWallet && (
            <p className="empty-state">
              No data found for this wallet yet — it may not have traded (or hasn&apos;t been
              ingested) within this project&apos;s coverage.
            </p>
          )}

          <div className="dashboard-grid">
            <section className="card">
              <h2>Smart Score</h2>
              <SmartScoreCard score={data.latestSmartScore} />
            </section>

            <section className="card">
              <h2>Wallet Stats</h2>
              <WalletStatsCard stats={data.stats} />
            </section>

            <section className="card">
              <h2>Activity Summary</h2>
              <ActivitySummaryCard summary={data.activitySummary} />
            </section>

            <section className="card">
              <h2>Market Breakdown</h2>
              <MarketBreakdownTable markets={data.marketBreakdown} />
            </section>

            <section className="card">
              <h2>Positions</h2>
              <PositionsTable positions={data.positions} />
            </section>

            <section className="card">
              <h2>Recent Trades</h2>
              <RecentTradesTable trades={data.recentTrades} />
            </section>

            <section className="card">
              <h2>Recent History</h2>
              <RecentHistoryTable events={data.recentHistory} />
            </section>

            <section className="card">
              <h2>Score History</h2>
              <ScoreHistoryTable history={data.smartScoreHistory} />
            </section>
          </div>
        </>
      )}
    </main>
  );
}
