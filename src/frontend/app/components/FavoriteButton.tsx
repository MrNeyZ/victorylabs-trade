'use client';

import { useWatchlist } from '../lib/watchlist';

/**
 * Star button — Phase 5.2. Self-contained (calls `useWatchlist()`
 * itself) specifically so every call site (wallet page, market page,
 * search dropdown, dashboard tables) just drops in
 * `<FavoriteButton type="wallet" id={pubkey} />` with no prop drilling
 * of favorite state down from a shared parent.
 *
 * Always `type="button"` and always calls `stopPropagation`/
 * `preventDefault` — it's frequently rendered as a *sibling* of a
 * `<Link>` (a search result row, a table cell) rather than nested
 * inside one, but stopping propagation defensively means it never
 * accidentally triggers a click handler further up the tree (e.g. the
 * search dropdown's own "click inside closes nothing, click outside
 * closes" logic) no matter how a future call site nests it.
 */
export function FavoriteButton({
  type,
  id,
  size = 'normal',
}: {
  type: 'wallet' | 'market';
  id: string;
  size?: 'normal' | 'small';
}) {
  const { isWalletFavorited, isMarketFavorited, toggleWallet, toggleMarket } = useWatchlist();
  const isFavorited = type === 'wallet' ? isWalletFavorited(id) : isMarketFavorited(id);
  const label = `${isFavorited ? 'Remove from' : 'Add to'} watchlist`;

  return (
    <button
      type="button"
      className={`favorite-button${size === 'small' ? ' favorite-button-small' : ''}${isFavorited ? ' favorite-button-active' : ''}`}
      aria-label={label}
      aria-pressed={isFavorited}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (type === 'wallet') {
          toggleWallet(id);
        } else {
          toggleMarket(id);
        }
      }}
    >
      {isFavorited ? '★' : '☆'}
    </button>
  );
}
