'use client';

import { useEffect, useState } from 'react';

/**
 * Falls back to the backend's own default port (see
 * src/backend/api/server.ts) when unset — Next's env-file loading is
 * scoped to src/frontend (its own project root when run via
 * `next dev src/frontend`), so a repo-root `.env` isn't picked up here
 * automatically. Documented in docs/... (see Phase 2.9 report) rather
 * than solved with extra env-loading plumbing, since the default already
 * matches local dev out of the box.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

/** Matches the initial-snapshot size to the in-memory cap, so the feed starts as full as it's ever going to get. */
const SNAPSHOT_LIMIT = 200;
const MAX_TRADES_IN_MEMORY = 200;

type ConnectionStatus = 'connecting' | 'live' | 'disconnected' | 'error';

interface Trade {
  id: string;
  ownerPubkey: string;
  marketId: string;
  eventId: string | null;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  amountUsd: string;
  priceUsd: string;
  eventTitle: string | null;
  marketTitle: string | null;
  message: string | null;
  isTeamMarket: boolean | null;
  upstreamTimestamp: string;
  observedAt: string;
}

interface SnapshotPayload {
  trades: Trade[];
}

function shortenPubkey(pubkey: string): string {
  return pubkey.length > 10 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

function formatUsd(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : value;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  disconnected: 'Disconnected',
  error: 'Error',
};

function StatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function HomePage() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    setStatus('connecting');

    const params = new URLSearchParams({ limit: String(SNAPSHOT_LIMIT) });
    const source = new EventSource(`${API_BASE_URL}/api/trades/stream?${params.toString()}`);

    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as SnapshotPayload;
      setTrades(payload.trades.slice(0, MAX_TRADES_IN_MEMORY));
      setStatus('live');
    });

    source.addEventListener('trade', (event) => {
      const trade = JSON.parse((event as MessageEvent<string>).data) as Trade;
      setTrades((prev) => [trade, ...prev].slice(0, MAX_TRADES_IN_MEMORY));
      setStatus('live');
    });

    source.addEventListener('heartbeat', () => {
      setStatus('live');
    });

    source.onerror = () => {
      // EventSource retries automatically on a transient drop (readyState
      // goes back to CONNECTING); CLOSED means the browser gave up (e.g.
      // the backend rejected the request outright) and won't retry itself.
      setStatus(source.readyState === EventSource.CLOSED ? 'error' : 'disconnected');
    };

    return () => {
      source.close();
    };
  }, []);

  return (
    <main>
      <h1>Live Trade Feed</h1>
      <StatusBadge status={status} />

      {trades.length === 0 ? (
        <p className="empty-state">Waiting for trades…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Action</th>
              <th>Side</th>
              <th>Market / Event</th>
              <th>Amount</th>
              <th>Price</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id} data-trade-id={trade.id}>
                <td title={trade.ownerPubkey}>{shortenPubkey(trade.ownerPubkey)}</td>
                <td className={`action-${trade.action}`}>{trade.action}</td>
                <td>{trade.side}</td>
                <td>{trade.eventTitle ?? trade.marketTitle ?? trade.marketId}</td>
                <td>{formatUsd(trade.amountUsd)}</td>
                <td>{formatUsd(trade.priceUsd)}</td>
                <td>{formatTime(trade.upstreamTimestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
