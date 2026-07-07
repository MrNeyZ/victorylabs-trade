/**
 * Shared realtime trade stream — Phase 5.5. Exactly one `EventSource` for
 * the whole tab, against the same `/api/trades/stream` endpoint
 * `app/page.tsx` already used on its own (Phase 3.x) — this module is a
 * module-level singleton specifically so every page that wants live
 * trades (dashboard, wallet detail, market detail, watchlist, and
 * `app/page.tsx` itself) subscribes to the one connection instead of each
 * opening its own, per this phase's "do not open multiple EventSource
 * connections" rule.
 *
 * No new backend endpoint, no filtering by `marketId`/`ownerPubkey` on the
 * connection URL (unlike `app/page.tsx`'s old per-page connection) — the
 * stream is opened once, unfiltered, and every subscriber filters
 * client-side on the fields it cares about (`trade.ownerPubkey`,
 * `trade.marketId`). That's the only way one shared connection can serve
 * pages with different filter needs at once.
 *
 * Deliberately module state + subscriber `Set`s, not React Context — this
 * matches the existing hand-rolled pattern `./watchlist.ts`/
 * `./notifications.ts` already use (module state + a change signal
 * components subscribe to), just with in-memory `Set`s of callbacks
 * instead of a `window` custom event, since trade payloads don't need to
 * round-trip through `localStorage`/DOM events here.
 */
import { useEffect, useSyncExternalStore } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

/** Matches `app/page.tsx`'s own prior constants — the initial snapshot is sized to the in-memory cap it feeds, so the feed starts as full as it's ever going to get. */
const SNAPSHOT_LIMIT = 200;
const MAX_TRADES_IN_MEMORY = 200;

export type ConnectionStatus = 'connecting' | 'live' | 'disconnected' | 'error';

/** Mirrors the backend's `Trade` domain type (`src/backend/types/domain.ts`) as serialized over SSE — see every page's own doc comment for why this project hand-mirrors backend JSON shapes instead of importing backend types directly. */
export interface RealtimeTrade {
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

type TradeListener = (trade: RealtimeTrade) => void;
type StatusListener = (status: ConnectionStatus) => void;
type TradesListListener = (trades: RealtimeTrade[]) => void;
type LastEventAtListener = (lastEventAt: number) => void;

let source: EventSource | null = null;
let status: ConnectionStatus = 'connecting';
/** Rolling most-recent-first trade list, capped at `MAX_TRADES_IN_MEMORY` — only `app/page.tsx` (the Live Feed) renders this directly; every other page uses `useRealtimeTrades` below to react to individual trades instead. */
let recentTrades: RealtimeTrade[] = [];
/** `Date.now()` of the most recent `snapshot`/`trade`/`heartbeat`, whichever came last — matches `app/page.tsx`'s own prior "Updated HH:MM:SS" behavior, which used to bump on every one of those three, not just on an actual new trade. */
let lastEventAt: number | null = null;

const tradeListeners = new Set<TradeListener>();
const statusListeners = new Set<StatusListener>();
const tradesListListeners = new Set<TradesListListener>();
const lastEventAtListeners = new Set<LastEventAtListener>();

function setStatus(next: ConnectionStatus): void {
  if (status === next) return;
  status = next;
  statusListeners.forEach((listener) => listener(status));
}

function setRecentTrades(next: RealtimeTrade[]): void {
  recentTrades = next;
  tradesListListeners.forEach((listener) => listener(recentTrades));
}

function markLastEventAt(): void {
  lastEventAt = Date.now();
  lastEventAtListeners.forEach((listener) => listener(lastEventAt as number));
}

/**
 * Idempotent — safe to call from every hook below; the underlying
 * `EventSource` is created exactly once per tab, on whichever component
 * mounts (and therefore subscribes) first. There is no matching "close"
 * call anywhere: the connection is meant to live for the whole session,
 * the same way `app/page.tsx`'s own connection previously lived for as
 * long as that one page was mounted — just shared instead of per-page
 * now.
 */
function ensureConnected(): void {
  if (source !== null || typeof window === 'undefined') return;

  setStatus('connecting');

  const params = new URLSearchParams({ limit: String(SNAPSHOT_LIMIT) });
  const nextSource = new EventSource(`${API_BASE_URL}/api/trades/stream?${params.toString()}`);
  source = nextSource;

  nextSource.addEventListener('snapshot', (event) => {
    setStatus('live');
    markLastEventAt();
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      trades: RealtimeTrade[];
    };
    setRecentTrades(payload.trades.slice(0, MAX_TRADES_IN_MEMORY));
  });

  nextSource.addEventListener('trade', (event) => {
    setStatus('live');
    markLastEventAt();
    const trade = JSON.parse((event as MessageEvent<string>).data) as RealtimeTrade;
    setRecentTrades([trade, ...recentTrades].slice(0, MAX_TRADES_IN_MEMORY));
    tradeListeners.forEach((listener) => listener(trade));
  });

  nextSource.addEventListener('heartbeat', () => {
    setStatus('live');
    markLastEventAt();
  });

  nextSource.onerror = () => {
    // EventSource retries automatically on a transient drop (readyState
    // goes back to CONNECTING); CLOSED means the browser gave up (e.g.
    // the backend rejected the request outright) and won't retry itself.
    setStatus(nextSource.readyState === EventSource.CLOSED ? 'error' : 'disconnected');
  };
}

function subscribeStatus(listener: StatusListener): () => void {
  ensureConnected();
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function subscribeTradesList(listener: TradesListListener): () => void {
  ensureConnected();
  tradesListListeners.add(listener);
  return () => {
    tradesListListeners.delete(listener);
  };
}

function subscribeLastEventAt(listener: LastEventAtListener): () => void {
  ensureConnected();
  lastEventAtListeners.add(listener);
  return () => {
    lastEventAtListeners.delete(listener);
  };
}

function statusSnapshot(): ConnectionStatus {
  return status;
}

function tradesListSnapshot(): RealtimeTrade[] {
  return recentTrades;
}

function lastEventAtSnapshot(): number | null {
  return lastEventAt;
}

/** Live connection status (`connecting` / `live` / `disconnected` / `error`) — for the shared nav badge (`components/ConnectionStatusBadge.tsx`) and any page that wants to know it's showing possibly-stale data. */
export function useRealtimeStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribeStatus, statusSnapshot, () => 'connecting');
}

/** The rolling most-recent-first trade list — only `app/page.tsx` (Live Feed) uses this; it's the one page that renders raw trades rather than reacting to "something changed, go refetch my own bundle". */
export function useRealtimeTradesList(): RealtimeTrade[] {
  return useSyncExternalStore(subscribeTradesList, tradesListSnapshot, () => []);
}

/** `Date.now()` of the most recent `snapshot`/`trade`/`heartbeat` — `app/page.tsx`'s "Updated HH:MM:SS" text. */
export function useRealtimeLastEventAt(): number | null {
  return useSyncExternalStore(subscribeLastEventAt, lastEventAtSnapshot, () => null);
}

/**
 * Subscribes `onTrade` to every trade on the shared stream for the
 * lifetime of the calling component. `onTrade` is called for every trade
 * the whole terminal sees, not just ones relevant to the calling page —
 * callers that only care about a specific wallet/market filter inside
 * their own callback (usually scheduling a debounced refetch, not
 * rendering the trade itself — nothing here forces a re-render, unlike
 * `useRealtimeTradesList`/`useRealtimeStatus` above).
 */
export function useRealtimeTrades(onTrade: TradeListener): void {
  useEffect(() => {
    ensureConnected();
    tradeListeners.add(onTrade);
    return () => {
      tradeListeners.delete(onTrade);
    };
  }, [onTrade]);
}
