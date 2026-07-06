/**
 * Shared badge components — Phase 3.10. Previously `SeverityBadge`/
 * `TierBadge` (and the string-union types they render) were each defined
 * twice (`dashboard/page.tsx`, `wallet/[walletPubkey]/page.tsx`),
 * verbatim. `WalletScoreTier`/`SignalSeverity` are exported from here so
 * every page's own response-shape interfaces can reference the same
 * type instead of re-declaring the union.
 */

export type WalletScoreTier = 'elite' | 'strong' | 'watch' | 'weak' | 'unknown';
export type SignalSeverity = 'low' | 'medium' | 'high';

export function TierBadge({ tier }: { tier: WalletScoreTier }) {
  return <span className={`badge tier-${tier}`}>{tier}</span>;
}

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return <span className={`badge severity-${severity}`}>{severity}</span>;
}
