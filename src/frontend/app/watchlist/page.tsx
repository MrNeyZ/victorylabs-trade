'use client';

import { useEffect, useState } from 'react';
import { useWatchlist } from '../lib/watchlist';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { FavoriteButton } from '../components/FavoriteButton';
import { WalletLink } from '../components/WalletLink';
import { MarketLink } from '../components/MarketLink';
import { TierBadge, type WalletScoreTier } from '../components/Badge';
import { formatScore, formatDateTime } from '../lib/format';

/** Same fallback/reasoning as every other page in this app. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

type RowLoadState = 'loading' | 'loaded' | 'error';

interface WalletRow {
  walletPubkey: string;
  loadState: RowLoadState;
  latestSmartScore: number | null;
  latestTier: WalletScoreTier | null;
  lastActivityAt: string | null;
}

interface MarketRow {
  marketId: string;
  loadState: RowLoadState;
  eventTitle: string | null;
  recentTradeCount: number | null;
  lastActivityAt: string | null;
}

function loadingWalletRow(walletPubkey: string): WalletRow {
  return {
    walletPubkey,
    loadState: 'loading',
    latestSmartScore: null,
    latestTier: null,
    lastActivityAt: null,
  };
}

function loadingMarketRow(marketId: string): MarketRow {
  return {
    marketId,
    loadState: 'loading',
    eventTitle: null,
    recentTradeCount: null,
    lastActivityAt: null,
  };
}

/**
 * Local-only watchlist — Phase 5.2. Reads favorite ids from
 * `localStorage` (`../lib/watchlist.ts`) and, for each one, fetches the
 * *same* existing endpoints the wallet/market detail pages already use
 * (`GET /api/wallets/:walletPubkey`, `GET /api/markets/:marketId`) to
 * show current metadata — nothing about a favorite's metadata is itself
 * stored locally, only the identifier, so this page can never show
 * stale Smart Score/activity data.
 *
 * Every fetch failure is caught per-item (`Promise.allSettled`, not
 * `Promise.all`) — one unreachable wallet/market must not blank out the
 * rest of the list; it falls back to a "Metadata unavailable" row that's
 * still linked and still removable.
 */
export default function WatchlistPage() {
  const { wallets, markets } = useWatchlist();
  const [walletRows, setWalletRows] = useState<WalletRow[]>([]);
  const [marketRows, setMarketRows] = useState<MarketRow[]>([]);

  // `wallets`/`markets` get a fresh array identity on every watchlist
  // change (see `useWatchlist`'s `readWatchlist`), including changes to
  // the *other* list — joining to a stable string avoids re-fetching
  // every wallet's metadata just because a market was favorited.
  const walletsKey = wallets.join(',');
  const marketsKey = markets.join(',');

  useEffect(() => {
    let cancelled = false;
    setWalletRows(wallets.map(loadingWalletRow));

    Promise.allSettled(
      wallets.map((walletPubkey) =>
        fetch(`${API_BASE_URL}/api/wallets/${encodeURIComponent(walletPubkey)}`).then(
          async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return (await response.json()) as {
              latestSmartScore: { score: number; tier: WalletScoreTier } | null;
              activitySummary: { lastSeenAt: string | null };
            };
          },
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      setWalletRows(
        wallets.map((walletPubkey, index) => {
          const result = results[index];
          if (result?.status === 'fulfilled') {
            const data = result.value;
            return {
              walletPubkey,
              loadState: 'loaded',
              latestSmartScore: data.latestSmartScore?.score ?? null,
              latestTier: data.latestSmartScore?.tier ?? null,
              lastActivityAt: data.activitySummary?.lastSeenAt ?? null,
            };
          }
          return {
            walletPubkey,
            loadState: 'error',
            latestSmartScore: null,
            latestTier: null,
            lastActivityAt: null,
          };
        }),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [walletsKey]);

  useEffect(() => {
    let cancelled = false;
    setMarketRows(markets.map(loadingMarketRow));

    Promise.allSettled(
      markets.map((marketId) =>
        fetch(`${API_BASE_URL}/api/markets/${encodeURIComponent(marketId)}`).then(
          async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return (await response.json()) as {
              eventTitle: string | null;
              activitySummary: { totalTrades: number; lastSeenAt: string | null };
            };
          },
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      setMarketRows(
        markets.map((marketId, index) => {
          const result = results[index];
          if (result?.status === 'fulfilled') {
            const data = result.value;
            return {
              marketId,
              loadState: 'loaded',
              eventTitle: data.eventTitle,
              recentTradeCount: data.activitySummary?.totalTrades ?? null,
              lastActivityAt: data.activitySummary?.lastSeenAt ?? null,
            };
          }
          return {
            marketId,
            loadState: 'error',
            eventTitle: null,
            recentTradeCount: null,
            lastActivityAt: null,
          };
        }),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [marketsKey]);

  return (
    <main>
      <h1>Watchlist</h1>
      <p className="watchlist-note">
        Saved in this browser — favorites don&apos;t sync across devices.
      </p>

      <div className="dashboard-grid">
        <SectionCard title="Favorite Wallets">
          {walletRows.length === 0 ? (
            <EmptyState message="No favorite wallets yet — star a wallet to add it here." />
          ) : (
            walletRows.map((row) => (
              <div key={row.walletPubkey} className="watchlist-row">
                <div>
                  <div className="watchlist-row-primary">
                    <WalletLink pubkey={row.walletPubkey} />
                    {row.loadState === 'loaded' && row.latestTier && (
                      <TierBadge tier={row.latestTier} />
                    )}
                  </div>
                  <div className="watchlist-row-meta">
                    {row.loadState === 'loading' && 'Loading…'}
                    {row.loadState === 'error' && 'Metadata unavailable.'}
                    {row.loadState === 'loaded' && (
                      <>
                        {row.latestSmartScore !== null
                          ? `Score ${formatScore(row.latestSmartScore)} · `
                          : ''}
                        Last active {formatDateTime(row.lastActivityAt)}
                      </>
                    )}
                  </div>
                </div>
                <FavoriteButton type="wallet" id={row.walletPubkey} />
              </div>
            ))
          )}
        </SectionCard>

        <SectionCard title="Favorite Markets">
          {marketRows.length === 0 ? (
            <EmptyState message="No favorite markets yet — star a market to add it here." />
          ) : (
            marketRows.map((row) => (
              <div key={row.marketId} className="watchlist-row">
                <div>
                  <div className="watchlist-row-primary">
                    <MarketLink marketId={row.marketId} label={row.eventTitle} />
                  </div>
                  <div className="watchlist-row-meta">
                    {row.loadState === 'loading' && 'Loading…'}
                    {row.loadState === 'error' && 'Metadata unavailable.'}
                    {row.loadState === 'loaded' && (
                      <>
                        {row.recentTradeCount !== null ? `${row.recentTradeCount} trade(s) · ` : ''}
                        Last active {formatDateTime(row.lastActivityAt)}
                      </>
                    )}
                  </div>
                </div>
                <FavoriteButton type="market" id={row.marketId} />
              </div>
            ))
          )}
        </SectionCard>
      </div>
    </main>
  );
}
