import Link from 'next/link';
import { FavoriteButton } from './FavoriteButton';

/**
 * Every market id rendered anywhere on the dashboard, live feed, or
 * wallet detail page links to its market detail page
 * (`/market/[marketId]`, Phase 4.3) — same extraction reasoning as
 * `WalletLink.tsx`. `label` defaults to `marketId` itself; callers that
 * already have an `eventTitle` pass it in as a friendlier link label
 * while `marketId` still supplies the URL and the tooltip. `showFavorite`
 * (Phase 5.2, opt-in, default off) — same reasoning as `WalletLink`'s.
 */
export function MarketLink({
  marketId,
  label,
  showFavorite,
}: {
  marketId: string;
  label?: string | null;
  showFavorite?: boolean;
}) {
  return (
    <>
      <Link href={`/market/${marketId}`} title={marketId}>
        {label ?? marketId}
      </Link>
      {showFavorite && <FavoriteButton type="market" id={marketId} size="small" />}
    </>
  );
}
