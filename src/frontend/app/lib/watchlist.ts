/**
 * Local-only favorites/watchlist — Phase 5.2. Everything here is
 * `localStorage`, never the backend: no auth, no DB table, no sync
 * across devices/browsers, exactly per this phase's brief. A single key
 * (`STORAGE_KEY`) holds just the identifiers (wallet pubkeys, market
 * ids) — never a cached copy of their metadata, so the watchlist page
 * always shows current Smart Score/activity by fetching the same
 * existing APIs every other page already uses, not a stale snapshot
 * that could drift from reality.
 *
 * `useWatchlist()` is the only thing components should use directly —
 * `readWatchlist`/`writeWatchlist` are exported for the hook's own use
 * and are safe to call from anywhere, but bypass the cross-component
 * sync `useWatchlist()` provides (see below).
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'vltrade:watchlist';
/** Same-tab components don't see each other's `localStorage` writes via the native `storage` event (that only fires in *other* tabs/windows) — this custom event is how e.g. the search dropdown's star and the wallet page's star, both mounted at once, stay in sync when either one toggles a favorite. */
const CHANGE_EVENT = 'vltrade:watchlist-changed';

export interface WatchlistState {
  wallets: string[];
  markets: string[];
}

const EMPTY_WATCHLIST: WatchlistState = { wallets: [], markets: [] };

function isWatchlistState(value: unknown): value is WatchlistState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['wallets']) &&
    Array.isArray(candidate['markets']) &&
    candidate['wallets'].every((item) => typeof item === 'string') &&
    candidate['markets'].every((item) => typeof item === 'string')
  );
}

/** `window`-guarded so this is safe to call during SSR/the initial render (both return the empty default there — real data loads client-side in `useWatchlist`'s effect, same "hydrate then load" pattern every other page's `fetch`-on-mount already uses). */
export function readWatchlist(): WatchlistState {
  if (typeof window === 'undefined') return EMPTY_WATCHLIST;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY_WATCHLIST;
    const parsed: unknown = JSON.parse(raw);
    return isWatchlistState(parsed) ? parsed : EMPTY_WATCHLIST;
  } catch {
    // Corrupt/unparseable localStorage content — treat as empty rather
    // than throwing and breaking every page that renders a star.
    return EMPTY_WATCHLIST;
  }
}

function writeWatchlist(state: WatchlistState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Every component that needs to read or mutate favorites uses this hook
 * — it re-reads `localStorage` (its own writes, another component's, or
 * a manual `localStorage.clear()`) whenever `CHANGE_EVENT` fires, so a
 * star toggled in the search dropdown is reflected instantly on the
 * wallet page's own star if both happen to be mounted, and the
 * watchlist page updates live as items are removed elsewhere.
 */
export function useWatchlist() {
  const [state, setState] = useState<WatchlistState>(EMPTY_WATCHLIST);

  useEffect(() => {
    setState(readWatchlist());

    function handleChange() {
      setState(readWatchlist());
    }
    window.addEventListener(CHANGE_EVENT, handleChange);
    window.addEventListener('storage', handleChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  const toggleWallet = useCallback((walletPubkey: string) => {
    const current = readWatchlist();
    const isFavorited = current.wallets.includes(walletPubkey);
    writeWatchlist({
      ...current,
      wallets: isFavorited
        ? current.wallets.filter((pubkey) => pubkey !== walletPubkey)
        : [...current.wallets, walletPubkey],
    });
  }, []);

  const toggleMarket = useCallback((marketId: string) => {
    const current = readWatchlist();
    const isFavorited = current.markets.includes(marketId);
    writeWatchlist({
      ...current,
      markets: isFavorited
        ? current.markets.filter((id) => id !== marketId)
        : [...current.markets, marketId],
    });
  }, []);

  return {
    wallets: state.wallets,
    markets: state.markets,
    isWalletFavorited: (walletPubkey: string) => state.wallets.includes(walletPubkey),
    isMarketFavorited: (marketId: string) => state.markets.includes(marketId),
    toggleWallet,
    toggleMarket,
  };
}
