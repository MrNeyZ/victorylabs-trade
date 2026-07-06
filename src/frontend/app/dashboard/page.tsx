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

export default function DashboardPage() {
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<DashboardResponse | null>(null);
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

    return fetch(`${API_BASE_URL}/api/dashboard`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Dashboard request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as DashboardResponse;
      })
      .then((payload) => {
        if (!mountedRef.current) return;
        setData(payload);
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
          </div>
        </>
      )}
    </main>
  );
}
