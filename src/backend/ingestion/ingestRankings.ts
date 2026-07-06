/**
 * Bounded job: ingest all 3 leaderboard periods once, then ingest
 * `/profiles` for the top N wallets by all-time realized PnL — reusing
 * the ranking `ingestLeaderboards` already fetched (no redundant API
 * call). Bounded by wallet count only — no forever mode, no daemon.
 * See `src/backend/jobs/ingestRankings.ts` for the CLI entry point
 * (`npm run ingest:rankings`).
 *
 * Rate-limit handling (429s) is no longer a fixed inter-request sleep
 * here (Phase 2.5) -- as of Phase 2.6 it's delegated entirely to
 * JupiterPredictionClient's own retry/backoff. This file just calls the
 * client normally now.
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { ingestLeaderboards, type IngestLeaderboardsResult } from './ingestLeaderboards.js';
import { ingestWalletProfile, type IngestWalletProfileResult } from './ingestWalletProfile.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

export const DEFAULT_TOP_N = 20;

export interface IngestRankingsOptions {
  /** How many top (by all-time realized PnL) wallets to ingest profiles for. Default: 20. */
  topN?: number;
  client?: JupiterPredictionClient;
}

export type WalletProfileOutcome =
  | { ownerPubkey: string; ok: true; result: IngestWalletProfileResult }
  | { ownerPubkey: string; ok: false; error: string };

export interface IngestRankingsResult {
  leaderboards: IngestLeaderboardsResult;
  walletsConsidered: number;
  succeeded: number;
  failed: number;
  outcomes: WalletProfileOutcome[];
}

export async function ingestRankings(
  options: IngestRankingsOptions = {},
): Promise<IngestRankingsResult> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  if (!Number.isFinite(topN) || topN < 1) {
    throw new Error(`ingestRankings: topN must be a positive integer, got ${topN}`);
  }

  const client = options.client ?? new JupiterPredictionClient(clientOptionsFromEnv());
  const leaderboards = await ingestLeaderboards(client);
  const topWallets = leaderboards.allTimeWallets.slice(0, topN);

  console.log(
    `[ingest:rankings] ingesting profiles for top ${topWallets.length} wallet(s) (topN=${topN})`,
  );

  const outcomes: WalletProfileOutcome[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const ownerPubkey of topWallets) {
    try {
      const result = await ingestWalletProfile(ownerPubkey, client);
      outcomes.push({ ownerPubkey, ok: true, result });
      succeeded += 1;
    } catch (err) {
      // Deliberately continue to the next wallet — one wallet's failure
      // (already recorded as its own error row in ingestion_runs by
      // ingestWalletProfile) should not abort the rest of this bounded
      // batch, same reasoning as ingestRecentWalletHistory.ts.
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ ownerPubkey, ok: false, error: message });
      failed += 1;
    }
  }

  console.log(
    `[ingest:rankings] done — leaderboards + ${succeeded} profile(s) succeeded, ${failed} failed`,
  );

  return {
    leaderboards,
    walletsConsidered: topWallets.length,
    succeeded,
    failed,
    outcomes,
  };
}
