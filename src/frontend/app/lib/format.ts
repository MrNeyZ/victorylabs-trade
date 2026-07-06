/**
 * Shared formatting helpers — Phase 3.10. Previously each page
 * (`page.tsx`, `dashboard/page.tsx`, `wallet/[walletPubkey]/page.tsx`)
 * hand-rolled its own `shortenPubkey`/`formatUsd`/`formatTime`; this
 * consolidates them into one module so the three pages' output is
 * actually guaranteed consistent (same rounding, same "—" placeholder
 * for missing values, same invalid-date guard) rather than three
 * independently-written near-duplicates that could drift.
 */

export function shortenPubkey(pubkey: string): string {
  return pubkey.length > 10 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

/** `null` in, `"—"` out — every USD amount in this project's API responses is a nullable decimal string, never a plain missing field, so callers pass the value straight through without their own null check. */
export function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : value;
}

/** A 0-100 Smart Score, framed with its scale (`"6/100"`) — a bare number in a "Score" column or next to a tier badge reads ambiguously at a glance, the denominator doesn't. */
export function formatScore(score: number): string {
  return `${score}/100`;
}

/** `fraction` is 0-1 (e.g. `correctPredictions / predictionsCount`), not already ×100. */
export function formatPercent(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

function parseDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Full date + time — for tables/cards where entries can span days (dashboard, wallet detail). `null` in, `"—"` out; an unparseable string is returned as-is rather than hidden. */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = parseDate(iso);
  return date ? date.toLocaleString() : iso;
}

/** Time only, no date — for the live feed, where every row is from today and repeating today's date on 200 rows is pure noise. */
export function formatTimeOnly(iso: string): string {
  const date = parseDate(iso);
  return date ? date.toLocaleTimeString() : iso;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
