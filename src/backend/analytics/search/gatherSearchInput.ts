/**
 * The impure half of global search: fetches everything
 * `computeSearchResults.ts` needs from Postgres. I/O only, same split as
 * every other analytics module in this project.
 *
 * Unlike Trending Wallets/Markets, the repository's own `LIMIT` is
 * already the final result count, not an over-fetched candidate pool —
 * the ranking here is (activity desc, then score desc for wallets), and
 * the repository already orders by activity desc, so no wallet outside
 * the top `limit` by activity could ever be promoted back in by the
 * score tie-break. Fetching more than `limit` candidates would do
 * nothing but extra work.
 */
import { searchWalletsByPrefix, searchMarkets } from '../../db/repositories/searchRepository.js';
import {
  getLatestScoresForWallets,
  type WalletScoreSnapshotResult,
} from '../../db/repositories/walletScoresRepository.js';
import type {
  WalletSearchCandidate,
  MarketSearchCandidate,
} from '../../db/repositories/searchRepository.js';

export interface SearchInput {
  walletCandidates: WalletSearchCandidate[];
  marketCandidates: MarketSearchCandidate[];
  scoresByWallet: Map<string, WalletScoreSnapshotResult>;
}

export async function gatherSearchInput(query: string, limit: number): Promise<SearchInput> {
  const [walletCandidates, marketCandidates] = await Promise.all([
    searchWalletsByPrefix(query, limit),
    searchMarkets(query, limit),
  ]);

  const scores = await getLatestScoresForWallets(
    walletCandidates.map((candidate) => candidate.walletPubkey),
  );
  const scoresByWallet = new Map(scores.map((score) => [score.walletPubkey, score]));

  return { walletCandidates, marketCandidates, scoresByWallet };
}
