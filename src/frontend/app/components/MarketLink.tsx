import Link from 'next/link';

/**
 * Every market id rendered anywhere on the dashboard, live feed, or
 * wallet detail page links to its market detail page
 * (`/market/[marketId]`, Phase 4.3) — same extraction reasoning as
 * `WalletLink.tsx`. `label` defaults to `marketId` itself; callers that
 * already have an `eventTitle` pass it in as a friendlier link label
 * while `marketId` still supplies the URL and the tooltip.
 */
export function MarketLink({ marketId, label }: { marketId: string; label?: string | null }) {
  return (
    <Link href={`/market/${marketId}`} title={marketId}>
      {label ?? marketId}
    </Link>
  );
}
