'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDateTime, formatScore, shortenPubkey } from '../lib/format';
import { TierBadge, type WalletScoreTier } from './Badge';
import { FavoriteButton } from './FavoriteButton';

/** Same fallback/reasoning as every other page in this app. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

type SearchState = 'idle' | 'loading' | 'loaded' | 'error';

/** Mirrors the backend's `WalletSearchResult`/`MarketSearchResult` (`src/backend/analytics/search/computeSearchResults.ts`) — not imported directly, same convention every other page in this app follows. */
interface WalletSearchResult {
  walletPubkey: string;
  latestSmartScore: number | null;
  latestTier: WalletScoreTier | null;
  recentTradeCount: number;
  lastActivityAt: string;
}

interface MarketSearchResult {
  marketId: string;
  eventTitle: string | null;
  recentTradeCount: number;
  lastActivityAt: string;
}

interface SearchResponse {
  wallets: WalletSearchResult[];
  markets: MarketSearchResult[];
}

const EMPTY_RESULTS: SearchResponse = { wallets: [], markets: [] };

function firstResultHref(results: SearchResponse): string | null {
  if (results.wallets.length > 0) return `/wallet/${results.wallets[0]!.walletPubkey}`;
  if (results.markets.length > 0) return `/market/${results.markets[0]!.marketId}`;
  return null;
}

/**
 * Shared global search — Phase 5.1. Lives in `app/layout.tsx`'s nav (a
 * Server Component) as a Client Component child, so the layout itself
 * doesn't need `'use client'`/lose its `metadata` export just to gain
 * search. No client-side filtering: every keystroke past
 * `MIN_QUERY_LENGTH`, debounced, re-fetches `GET /api/search` fresh —
 * the dropdown only ever renders exactly what the backend just returned.
 */
export function GlobalSearch() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against an earlier, slower request's response overwriting a
  // later one's (classic out-of-order-network-response race) — only the
  // response whose id still matches the latest dispatched request wins.
  const requestIdRef = useRef(0);

  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [results, setResults] = useState<SearchResponse>(EMPTY_RESULTS);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      requestIdRef.current += 1;
      setState('idle');
      setResults(EMPTY_RESULTS);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setState('loading');

      fetch(`${API_BASE_URL}/api/search?q=${encodeURIComponent(trimmed)}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Search failed (HTTP ${response.status})`);
          }
          return (await response.json()) as SearchResponse;
        })
        .then((payload) => {
          if (requestId !== requestIdRef.current) return;
          setResults(payload);
          setState('loaded');
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setState('error');
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setIsOpen(false);
      event.currentTarget.blur();
    } else if (event.key === 'Enter') {
      const href = firstResultHref(results);
      if (href) {
        setIsOpen(false);
        router.push(href);
      }
    }
  }

  const trimmedLength = query.trim().length;
  const showDropdown = isOpen && trimmedLength >= MIN_QUERY_LENGTH;
  const hasResults = results.wallets.length > 0 || results.markets.length > 0;

  return (
    <div className="search-bar" ref={containerRef}>
      <input
        type="text"
        className="search-input"
        placeholder="Search wallets or markets…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          if (trimmedLength >= MIN_QUERY_LENGTH) setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        aria-label="Search wallets or markets"
      />

      {showDropdown && (
        <div className="search-dropdown">
          {state === 'loading' && <p className="search-loading">Searching…</p>}
          {state === 'error' && <p className="search-error">Search failed.</p>}
          {state === 'loaded' && !hasResults && <p className="search-empty">No results</p>}
          {state === 'loaded' && hasResults && (
            <>
              {results.wallets.length > 0 && (
                <div className="search-section">
                  <div className="search-section-label">Wallets</div>
                  {results.wallets.map((wallet) => (
                    <div key={wallet.walletPubkey} className="search-result-row">
                      <Link
                        href={`/wallet/${wallet.walletPubkey}`}
                        className="search-result"
                        onClick={() => setIsOpen(false)}
                      >
                        <span className="search-result-primary">
                          {shortenPubkey(wallet.walletPubkey)}
                          {wallet.latestTier && <TierBadge tier={wallet.latestTier} />}
                        </span>
                        <span className="search-result-meta">
                          {wallet.latestSmartScore !== null
                            ? `Score ${formatScore(wallet.latestSmartScore)} · `
                            : ''}
                          {wallet.recentTradeCount} trade(s) · last active{' '}
                          {formatDateTime(wallet.lastActivityAt)}
                        </span>
                      </Link>
                      <FavoriteButton type="wallet" id={wallet.walletPubkey} size="small" />
                    </div>
                  ))}
                </div>
              )}

              {results.markets.length > 0 && (
                <div className="search-section">
                  <div className="search-section-label">Markets</div>
                  {results.markets.map((market) => (
                    <div key={market.marketId} className="search-result-row">
                      <Link
                        href={`/market/${market.marketId}`}
                        className="search-result"
                        onClick={() => setIsOpen(false)}
                      >
                        <span className="search-result-primary">
                          {market.eventTitle ?? market.marketId}
                        </span>
                        <span className="search-result-meta">
                          {market.recentTradeCount} trade(s) · last active{' '}
                          {formatDateTime(market.lastActivityAt)}
                        </span>
                      </Link>
                      <FavoriteButton type="market" id={market.marketId} size="small" />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
