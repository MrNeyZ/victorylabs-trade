/**
 * Bounded job: ingest `/positions` once for each of the N most recently
 * active wallets (from `tradesRepository.getRecentActiveWallets`).
 * Bounded by wallet count only — no forever mode, no interval, no daemon:
 * a single pass over a fixed candidate list, then done. See
 * `src/backend/jobs/ingestRecentWalletPositions.ts` for the CLI entry
 * point (`npm run ingest:positions:recent`).
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { getRecentActiveWallets } from '../db/repositories/tradesRepository.js';
import {
  ingestPositionsForWallet,
  type IngestPositionsForWalletResult,
} from './ingestPositionsForWallet.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

export const DEFAULT_POSITIONS_WALLET_LIMIT = 5;
export const DEFAULT_POSITIONS_SINCE_MINUTES = 60;

export interface IngestRecentWalletPositionsOptions {
  /** Max number of wallets to ingest positions for. Default: 5. */
  limit?: number;
  /** How far back "recently active" looks, fed to getRecentActiveWallets. Default: 60. */
  sinceMinutes?: number;
  client?: JupiterPredictionClient;
}

export type WalletPositionsOutcome =
  | { ownerPubkey: string; ok: true; result: IngestPositionsForWalletResult }
  | { ownerPubkey: string; ok: false; error: string };

export interface IngestRecentWalletPositionsResult {
  walletsConsidered: number;
  succeeded: number;
  failed: number;
  outcomes: WalletPositionsOutcome[];
}

export async function ingestRecentWalletPositions(
  options: IngestRecentWalletPositionsOptions = {},
): Promise<IngestRecentWalletPositionsResult> {
  const limit = options.limit ?? DEFAULT_POSITIONS_WALLET_LIMIT;
  const sinceMinutes = options.sinceMinutes ?? DEFAULT_POSITIONS_SINCE_MINUTES;

  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`ingestRecentWalletPositions: limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isFinite(sinceMinutes) || sinceMinutes < 1) {
    throw new Error(
      `ingestRecentWalletPositions: sinceMinutes must be a positive integer, got ${sinceMinutes}`,
    );
  }

  const client = options.client ?? new JupiterPredictionClient(clientOptionsFromEnv());
  const wallets = await getRecentActiveWallets({ sinceMinutes, limit });

  console.log(
    `[ingest:positions:recent] ${wallets.length} candidate wallet(s) ` +
      `(limit=${limit}, sinceMinutes=${sinceMinutes})`,
  );

  const outcomes: WalletPositionsOutcome[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const ownerPubkey of wallets) {
    try {
      const result = await ingestPositionsForWallet(ownerPubkey, client);
      outcomes.push({ ownerPubkey, ok: true, result });
      succeeded += 1;
    } catch (err) {
      // Deliberately continue to the next wallet — one wallet's failure
      // (already recorded as its own error row in ingestion_runs by
      // ingestPositionsForWallet) should not abort the rest of this
      // bounded batch, same reasoning as ingestRecentWalletHistory.ts.
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ ownerPubkey, ok: false, error: message });
      failed += 1;
    }
  }

  console.log(
    `[ingest:positions:recent] done — ${succeeded} succeeded, ${failed} failed, ` +
      `${wallets.length} considered`,
  );

  return { walletsConsidered: wallets.length, succeeded, failed, outcomes };
}
