/**
 * Candidate-wallet pool for the Smart Score leaderboard
 * (`src/backend/jobs/analyticsLeaderboard.ts`) — the union of every
 * wallet pubkey visible from four independent angles, deduplicated:
 *   - recently active traders (`trades`)
 *   - anyone who has ever appeared on a leaderboard snapshot
 *   - anyone with a wallet_profiles row
 *   - anyone with at least one ingested position
 *
 * This is deliberately a wide net, not a ranking — `computeWalletScore`
 * does the actual judging afterward. A wallet showing up here is not a
 * claim it's any good, just that this project has *some* data on it
 * worth scoring.
 */
import { getRecentActiveWallets } from '../../db/repositories/tradesRepository.js';
import { getDistinctLeaderboardWalletPubkeys } from '../../db/repositories/leaderboardsRepository.js';
import { getAllWalletProfilePubkeys } from '../../db/repositories/walletProfilesRepository.js';
import { getDistinctPositionOwnerPubkeys } from '../../db/repositories/positionsRepository.js';

export interface GatherCandidateWalletsOptions {
  /** How far back "recently active" (the `trades` source) looks. Default: 1440 (24h) — wider than `getRecentActiveWallets`'s own 60-minute default, since this is gathering a broad scoring pool, not "just traded, go enrich it now". */
  sinceMinutes?: number;
  /** Per-source cap, independently applied to each of the 4 queries before deduplication. Default: 500. */
  limitPerSource?: number;
}

const DEFAULT_SINCE_MINUTES = 24 * 60;
const DEFAULT_LIMIT_PER_SOURCE = 500;

export async function gatherCandidateWallets(
  options: GatherCandidateWalletsOptions = {},
): Promise<string[]> {
  const sinceMinutes = options.sinceMinutes ?? DEFAULT_SINCE_MINUTES;
  const limitPerSource = options.limitPerSource ?? DEFAULT_LIMIT_PER_SOURCE;

  const [fromTrades, fromLeaderboard, fromProfiles, fromPositions] = await Promise.all([
    getRecentActiveWallets({ sinceMinutes, limit: limitPerSource }),
    getDistinctLeaderboardWalletPubkeys(limitPerSource),
    getAllWalletProfilePubkeys(limitPerSource),
    getDistinctPositionOwnerPubkeys(limitPerSource),
  ]);

  return Array.from(
    new Set([...fromTrades, ...fromLeaderboard, ...fromProfiles, ...fromPositions]),
  );
}
