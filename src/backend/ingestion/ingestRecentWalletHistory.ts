/**
 * Bounded job: ingest `/history` once for each of the N most recently
 * active wallets (from `tradesRepository.getRecentActiveWallets`).
 * Bounded by wallet count only — no forever mode, no interval, no daemon:
 * a single pass over a fixed candidate list, then done. See
 * `src/backend/jobs/ingestRecentWalletHistory.ts` for the CLI entry point
 * (`npm run ingest:history:recent`).
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { getRecentActiveWallets } from '../db/repositories/tradesRepository.js';
import {
  ingestHistoryForWallet,
  type IngestHistoryForWalletResult,
} from './ingestHistoryForWallet.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

export const DEFAULT_WALLET_LIMIT = 5;
export const DEFAULT_SINCE_MINUTES = 60;

export interface IngestRecentWalletHistoryOptions {
  /** Max number of wallets to ingest history for. Default: 5. */
  limit?: number;
  /** How far back "recently active" looks, fed to getRecentActiveWallets. Default: 60. */
  sinceMinutes?: number;
  client?: JupiterPredictionClient;
}

export type WalletHistoryOutcome =
  | { ownerPubkey: string; ok: true; result: IngestHistoryForWalletResult }
  | { ownerPubkey: string; ok: false; error: string };

export interface IngestRecentWalletHistoryResult {
  walletsConsidered: number;
  succeeded: number;
  failed: number;
  outcomes: WalletHistoryOutcome[];
}

export async function ingestRecentWalletHistory(
  options: IngestRecentWalletHistoryOptions = {},
): Promise<IngestRecentWalletHistoryResult> {
  const limit = options.limit ?? DEFAULT_WALLET_LIMIT;
  const sinceMinutes = options.sinceMinutes ?? DEFAULT_SINCE_MINUTES;

  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`ingestRecentWalletHistory: limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isFinite(sinceMinutes) || sinceMinutes < 1) {
    throw new Error(
      `ingestRecentWalletHistory: sinceMinutes must be a positive integer, got ${sinceMinutes}`,
    );
  }

  const client = options.client ?? new JupiterPredictionClient(clientOptionsFromEnv());
  const wallets = await getRecentActiveWallets({ sinceMinutes, limit });

  console.log(
    `[ingest:history:recent] ${wallets.length} candidate wallet(s) ` +
      `(limit=${limit}, sinceMinutes=${sinceMinutes})`,
  );

  const outcomes: WalletHistoryOutcome[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const ownerPubkey of wallets) {
    try {
      const result = await ingestHistoryForWallet(ownerPubkey, client);
      outcomes.push({ ownerPubkey, ok: true, result });
      succeeded += 1;
    } catch (err) {
      // Deliberately continue to the next wallet — one wallet's failure
      // (already recorded as its own error row in ingestion_runs by
      // ingestHistoryForWallet) should not abort the rest of this bounded
      // batch.
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ ownerPubkey, ok: false, error: message });
      failed += 1;
    }
  }

  console.log(
    `[ingest:history:recent] done — ${succeeded} succeeded, ${failed} failed, ` +
      `${wallets.length} considered`,
  );

  return { walletsConsidered: wallets.length, succeeded, failed, outcomes };
}
