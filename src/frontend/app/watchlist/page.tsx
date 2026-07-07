'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWatchlist } from '../lib/watchlist';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { FavoriteButton } from '../components/FavoriteButton';
import { WalletLink } from '../components/WalletLink';
import { MarketLink } from '../components/MarketLink';
import { TierBadge, type WalletScoreTier } from '../components/Badge';
import { formatScore, formatDateTime } from '../lib/format';
import { useRealtimeTrades, type RealtimeTrade } from '../lib/realtimeTrades';
import { useDebouncedCallback } from '../lib/useDebouncedCallback';

/** Same fallback/reasoning as every other page in this app. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

/** Phase 5.5: how long to wait after the last live trade affecting a watched wallet/market before refetching that group — coalesces a burst into one refresh instead of one per trade. */
const LIVE_REFRESH_DEBOUNCE_MS = 3_000;

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

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Phase 5.5: extracted from the effect below so a live trade affecting
  // a watched wallet can trigger the same "refetch every watched wallet's
  // metadata" refresh a watchlist change already did — `isInitial` is the
  // only difference: a *new* watchlist (the effect below) resets rows to
  // a loading placeholder first, since there's nothing on screen for a
  // newly-favorited wallet yet; a *live* refresh (triggered from
  // `useRealtimeTrades` further down) leaves existing rows exactly as
  // they are until the new data arrives, same "keep last-good state"
  // rule every other page's live refresh already follows.
  const refreshWalletRows = useCallback(
    (isInitial: boolean) => {
      if (isInitial) setWalletRows(wallets.map(loadingWalletRow));

      return Promise.allSettled(
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
        if (!mountedRef.current) return;
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
    },
    [wallets],
  );

  const refreshMarketRows = useCallback(
    (isInitial: boolean) => {
      if (isInitial) setMarketRows(markets.map(loadingMarketRow));

      return Promise.allSettled(
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
        if (!mountedRef.current) return;
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
    },
    [markets],
  );

  // Re-runs (as a fresh load, resetting rows to a loading placeholder
  // first) only when the watchlist's actual *content* changes, not every
  // time `wallets`/`markets` gets a new array identity — same guard the
  // original version of this effect used.
  useEffect(() => {
    void refreshWalletRows(true);
    // Deliberately keyed on `walletsKey` (content), not `refreshWalletRows`
    // itself or the `wallets` array identity — see the comment above it.
  }, [walletsKey]);

  useEffect(() => {
    void refreshMarketRows(true);
    // Same reasoning as the wallet effect above.
  }, [marketsKey]);

  // Phase 5.5: live refresh. A trade matching a *watched* wallet/market
  // re-checks that whole group's metadata (same "reuse the existing
  // per-item fetch" shape as the effects above) — debounced per group so
  // a burst of trades across several watched items coalesces into one
  // refetch each, not one per trade.
  const scheduleWalletRefresh = useDebouncedCallback(() => {
    void refreshWalletRows(false);
  }, LIVE_REFRESH_DEBOUNCE_MS);
  const scheduleMarketRefresh = useDebouncedCallback(() => {
    void refreshMarketRows(false);
  }, LIVE_REFRESH_DEBOUNCE_MS);

  const handleRealtimeTrade = useCallback(
    (trade: RealtimeTrade) => {
      if (wallets.includes(trade.ownerPubkey)) scheduleWalletRefresh();
      if (markets.includes(trade.marketId)) scheduleMarketRefresh();
    },
    [wallets, markets, scheduleWalletRefresh, scheduleMarketRefresh],
  );
  useRealtimeTrades(handleRealtimeTrade);

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
