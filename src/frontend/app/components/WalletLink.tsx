import Link from 'next/link';
import { shortenPubkey } from '../lib/format';
import { FavoriteButton } from './FavoriteButton';

/**
 * Every wallet pubkey rendered anywhere on the live feed or dashboard
 * links to its detail page (`/wallet/[walletPubkey]`, Phase 3.9) —
 * extracted so that link, and its shortened-label/full-pubkey-tooltip
 * rendering, is defined once. `showFavorite` (Phase 5.2, opt-in, default
 * off) adds an inline star next to the link — turned on only for the
 * dashboard's "primary identity list" tables (Top/Active Smart Score
 * Wallets, Trending Wallets), not every table this component appears
 * in, per that phase's "if simple" brief.
 */
export function WalletLink({ pubkey, showFavorite }: { pubkey: string; showFavorite?: boolean }) {
  return (
    <>
      <Link href={`/wallet/${pubkey}`} title={pubkey}>
        {shortenPubkey(pubkey)}
      </Link>
      {showFavorite && <FavoriteButton type="wallet" id={pubkey} size="small" />}
    </>
  );
}

/** For signals with multiple wallets (`market_consensus`) — each pubkey its own link, comma-separated. */
export function WalletLinks({ pubkeys }: { pubkeys: string[] }) {
  return (
    <>
      {pubkeys.map((pubkey, index) => (
        <span key={pubkey}>
          {index > 0 && ', '}
          <WalletLink pubkey={pubkey} />
        </span>
      ))}
    </>
  );
}
