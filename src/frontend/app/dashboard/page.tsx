'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Same fallback/reasoning as `app/page.tsx` — Next's env-file loading is
 * scoped to `src/frontend`, so a repo-root `.env` isn't picked up here;
 * the default already matches local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

type LoadState = 'loading' | 'loaded' | 'error';

type SignalType = 'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';
type SignalSeverity = 'low' | 'medium' | 'high';
type WalletScoreTier = 'elite' | 'strong' | 'watch' | 'weak' | 'unknown';

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

function shortenPubkey(pubkey: string): string {
  return pubkey.length > 10 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

/** New in Phase 3.9 — every wallet pubkey rendered on this page links to its detail page (`/wallet/[walletPubkey]`). */
function WalletLink({ pubkey }: { pubkey: string }) {
  return (
    <Link href={`/wallet/${pubkey}`} title={pubkey}>
      {shortenPubkey(pubkey)}
    </Link>
  );
}

function WalletLinks({ pubkeys }: { pubkeys: string[] }) {
  return (
    <>
      {pubkeys.map((pubkey, index) => (
        <span key={pubkey}>
          {index > 0 && ', '}
          <WalletLink pubkey={pubkey} />
        </span>
      ))}
    </>
  );
}

function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : value;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return <span className={`badge severity-${severity}`}>{severity}</span>;
}

function TierBadge({ tier }: { tier: WalletScoreTier }) {
  return <span className={`badge tier-${tier}`}>{tier}</span>;
}

function EmptyState({ message }: { message: string }) {
  return <p className="empty-state">{message}</p>;
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
              <td>{formatTime(signal.occurredAt)}</td>
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
              <td>{wallet.score}</td>
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
              <td>{formatTime(market.lastTradeAt)}</td>
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

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    fetch(`${API_BASE_URL}/api/dashboard`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Dashboard request failed (HTTP ${response.status})`);
        }
        return (await response.json()) as DashboardResponse;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setState('loaded');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load dashboard');
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Smart Money Dashboard</h1>

      {state === 'loading' && <p className="empty-state">Loading dashboard…</p>}

      {state === 'error' && (
        <p className="error-state">
          Couldn&apos;t load the dashboard{errorMessage ? `: ${errorMessage}` : '.'}
        </p>
      )}

      {state === 'loaded' && data && (
        <>
          <p className="dashboard-meta">
            Generated {formatTime(data.generatedAt)} · last {data.lookbackMinutes} minute(s)
          </p>

          <div className="dashboard-grid">
            <section className="card">
              <h2>Latest Signals</h2>
              <SignalsTable
                signals={data.signals}
                emptyMessage="No signals detected in this window."
              />
            </section>

            <section className="card">
              <h2>Top Smart Score Wallets</h2>
              <WalletScoreTable
                wallets={data.topWallets}
                emptyMessage="No scored wallets yet — run analytics:scores."
              />
            </section>

            <section className="card">
              <h2>Whale Trades</h2>
              <SignalsTable
                signals={data.whaleTrades}
                emptyMessage="No whale trades in this window."
              />
            </section>

            <section className="card">
              <h2>Market Consensus</h2>
              <SignalsTable
                signals={data.consensus}
                emptyMessage="No consensus signals in this window."
              />
            </section>

            <section className="card">
              <h2>Top Active Markets</h2>
              <TopMarketsTable markets={data.topMarkets} />
            </section>

            <section className="card">
              <h2>Active Smart Wallets</h2>
              <WalletScoreTable
                wallets={data.activeSmartWallets}
                emptyMessage="No recently active wallets meet the smart-score bar."
              />
            </section>
          </div>
        </>
      )}
    </main>
  );
}
