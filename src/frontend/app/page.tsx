'use client';

import { formatTimeOnly, formatUsd } from './lib/format';
import { WalletLink } from './components/WalletLink';
import { MarketLink } from './components/MarketLink';
import { EmptyState } from './components/EmptyState';
import { ConnectionStatusBadge } from './components/ConnectionStatusBadge';
import { useRealtimeLastEventAt, useRealtimeTradesList } from './lib/realtimeTrades';

export default function HomePage() {
  // Phase 5.5: both come from the shared realtime module
  // (`lib/realtimeTrades.ts`) now, not a `new EventSource(...)` this page
  // used to own outright — see that module's doc comment for why (one
  // connection shared across the whole app, not one per page).
  const trades = useRealtimeTradesList();
  // "Updated HH:MM:SS" next to the connection badge — bumps on every
  // snapshot/trade/heartbeat, same as before this page shared its
  // connection with the rest of the app.
  const lastEventAt = useRealtimeLastEventAt();

  return (
    <main>
      <h1>Live Trade Feed</h1>
      <div className="status-row">
        <ConnectionStatusBadge />
        {lastEventAt !== null && (
          <span className="page-meta">
            Updated {formatTimeOnly(new Date(lastEventAt).toISOString())}
          </span>
        )}
      </div>

      {trades.length === 0 ? (
        <EmptyState message="Waiting for trades…" />
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
                <td>
                  <WalletLink pubkey={trade.ownerPubkey} />
                </td>
                <td className={`action-${trade.action}`}>{trade.action}</td>
                <td>{trade.side}</td>
                <td>
                  <MarketLink
                    marketId={trade.marketId}
                    label={trade.eventTitle ?? trade.marketTitle}
                  />
                </td>
                <td>{formatUsd(trade.amountUsd)}</td>
                <td>{formatUsd(trade.priceUsd)}</td>
                <td>{formatTimeOnly(trade.upstreamTimestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
