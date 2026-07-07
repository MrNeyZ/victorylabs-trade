/**
 * Dashboard filter state — Phase 5.4. Frontend-only, same `localStorage`
 * rule `./watchlist.ts`/`./notifications.ts` already follow: no backend
 * persistence, no auth. Single-tab only (no cross-tab change event) —
 * unlike the watchlist star, nothing else on the page needs to observe
 * another tab's filter choice.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SignalType } from './notifications';

const STORAGE_KEY = 'vltrade:dashboard-filters';

export type SortDirection = 'desc' | 'asc';

export interface DashboardFilters {
  lookbackMinutes: number;
  signalType: SignalType | 'all';
  minSmartScore: number;
  sortDirection: SortDirection;
}

/** Matches every section's own existing default (`/api/dashboard`, `/api/trending/*` all default `lookbackMinutes` to 1440; no type/score/sort filtering) — picking this as the default is what makes "no filters selected yet" identical to today's unfiltered dashboard. */
export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  lookbackMinutes: 1440,
  signalType: 'all',
  minSmartScore: 0,
  sortDirection: 'desc',
};

export const LOOKBACK_OPTIONS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d', minutes: 10_080 },
];

export const SIGNAL_TYPE_FILTER_OPTIONS: ReadonlyArray<{
  label: string;
  value: SignalType | 'all';
}> = [
  { label: 'All Types', value: 'all' },
  { label: 'Smart Wallet Trade', value: 'smart_wallet_trade' },
  { label: 'Elite Wallet Trade', value: 'elite_wallet_trade' },
  { label: 'Market Consensus', value: 'market_consensus' },
  { label: 'Whale Trade', value: 'whale_trade' },
];

const VALID_LOOKBACK_MINUTES = LOOKBACK_OPTIONS.map((option) => option.minutes);
const VALID_SIGNAL_TYPES = SIGNAL_TYPE_FILTER_OPTIONS.map((option) => option.value);

function isDashboardFilters(value: unknown): value is DashboardFilters {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['lookbackMinutes'] === 'number' &&
    VALID_LOOKBACK_MINUTES.includes(candidate['lookbackMinutes']) &&
    typeof candidate['signalType'] === 'string' &&
    VALID_SIGNAL_TYPES.includes(candidate['signalType'] as SignalType | 'all') &&
    typeof candidate['minSmartScore'] === 'number' &&
    Number.isFinite(candidate['minSmartScore']) &&
    (candidate['sortDirection'] === 'asc' || candidate['sortDirection'] === 'desc')
  );
}

function readDashboardFilters(): DashboardFilters {
  if (typeof window === 'undefined') return DEFAULT_DASHBOARD_FILTERS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_DASHBOARD_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    return isDashboardFilters(parsed) ? parsed : DEFAULT_DASHBOARD_FILTERS;
  } catch {
    // Corrupt/unparseable localStorage content — same "treat as empty
    // default" fallback `./watchlist.ts`'s `readWatchlist` uses.
    return DEFAULT_DASHBOARD_FILTERS;
  }
}

function writeDashboardFilters(filters: DashboardFilters): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
}

/**
 * `hydrated` starts `false` so the dashboard page's initial data fetch
 * can wait for the real (possibly-persisted) filters instead of firing
 * once with defaults and again moments later with whatever `localStorage`
 * actually held — see `dashboard/page.tsx`'s load effect.
 */
export function useDashboardFilters() {
  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_DASHBOARD_FILTERS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setFilters(readDashboardFilters());
    setHydrated(true);
  }, []);

  const updateFilters = useCallback((partial: Partial<DashboardFilters>) => {
    setFilters((current) => {
      const next = { ...current, ...partial };
      writeDashboardFilters(next);
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => {
    writeDashboardFilters(DEFAULT_DASHBOARD_FILTERS);
    setFilters(DEFAULT_DASHBOARD_FILTERS);
  }, []);

  return { filters, hydrated, updateFilters, resetFilters };
}

/** `desc` is a no-op (every ranked section is already backend-sorted highest-first) — `asc` just reverses the already-filtered list rather than re-sorting, since reversing a descending sort is an ascending sort of the same key. */
export function applySortDirection<T>(items: T[], direction: SortDirection): T[] {
  return direction === 'asc' ? [...items].reverse() : items;
}
