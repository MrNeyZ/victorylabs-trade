import Link from 'next/link';
import { shortenPubkey } from '../lib/format';

/** Every wallet pubkey rendered anywhere on the live feed or dashboard links to its detail page (`/wallet/[walletPubkey]`, Phase 3.9) — extracted so that link, and its shortened-label/full-pubkey-tooltip rendering, is defined once. */
export function WalletLink({ pubkey }: { pubkey: string }) {
  return (
    <Link href={`/wallet/${pubkey}`} title={pubkey}>
      {shortenPubkey(pubkey)}
    </Link>
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
