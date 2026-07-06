/**
 * Data-access layer for the `wallet_profiles` table. No business logic
 * here — just SQL. Callers are responsible for normalization
 * (`../../core/normalizeWalletProfile.ts`).
 *
 * Unlike `trades`/`history_events`, this is a TRUE upsert
 * (`ON CONFLICT ... DO UPDATE`), not `DO NOTHING` — a wallet's aggregate
 * PnL/volume genuinely changes over time, and `wallet_profiles` is
 * documented (see `001_init.sql`) as holding only the latest snapshot per
 * wallet, not a history (that's what `leaderboard_snapshots` is for).
 */
import { getPool } from '../client.js';
import type { WalletProfile } from '../../types/domain.js';
import type { JupiterProfile } from '../../types/jupiter.js';

export interface WalletProfileUpsertInput {
  profile: WalletProfile;
  /** Full upstream payload, stored verbatim in the `raw` JSONB column. */
  raw: JupiterProfile;
}

export async function upsertWalletProfile({
  profile,
  raw,
}: WalletProfileUpsertInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO wallet_profiles (
       wallet_pubkey, realized_pnl_usd, total_volume_usd, predictions_count,
       correct_predictions, wrong_predictions, total_active_contracts,
       total_active_contracts_micro, total_positions_value_usd, raw, snapshot_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (wallet_pubkey) DO UPDATE SET
       realized_pnl_usd             = EXCLUDED.realized_pnl_usd,
       total_volume_usd             = EXCLUDED.total_volume_usd,
       predictions_count            = EXCLUDED.predictions_count,
       correct_predictions          = EXCLUDED.correct_predictions,
       wrong_predictions            = EXCLUDED.wrong_predictions,
       total_active_contracts       = EXCLUDED.total_active_contracts,
       total_active_contracts_micro = EXCLUDED.total_active_contracts_micro,
       total_positions_value_usd    = EXCLUDED.total_positions_value_usd,
       raw                          = EXCLUDED.raw,
       snapshot_at                  = EXCLUDED.snapshot_at`,
    [
      profile.walletPubkey,
      profile.realizedPnlUsd,
      profile.totalVolumeUsd,
      profile.predictionsCount,
      profile.correctPredictions,
      profile.wrongPredictions,
      profile.totalActiveContracts,
      profile.totalActiveContractsMicro,
      profile.totalPositionsValueUsd,
      JSON.stringify(raw),
      profile.snapshotAt,
    ],
  );
}

export async function countWalletProfiles(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM wallet_profiles',
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Candidate-wallet source for the Smart Score leaderboard (`src/backend/analytics/scoring/gatherCandidateWallets.ts`) — every wallet with a profile snapshot. */
export async function getAllWalletProfilePubkeys(limit = 500): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ wallet_pubkey: string }>(
    'SELECT wallet_pubkey FROM wallet_profiles ORDER BY wallet_pubkey LIMIT $1',
    [limit],
  );
  return result.rows.map((row) => row.wallet_pubkey);
}

export async function getWalletProfile(walletPubkey: string): Promise<WalletProfile | null> {
  const pool = getPool();
  const result = await pool.query<{
    wallet_pubkey: string;
    realized_pnl_usd: string;
    total_volume_usd: string;
    predictions_count: number;
    correct_predictions: number;
    wrong_predictions: number;
    total_active_contracts: string | null;
    total_active_contracts_micro: string | null;
    total_positions_value_usd: string | null;
    snapshot_at: Date;
  }>('SELECT * FROM wallet_profiles WHERE wallet_pubkey = $1', [walletPubkey]);

  const row = result.rows[0];
  if (!row) return null;

  return {
    walletPubkey: row.wallet_pubkey,
    realizedPnlUsd: row.realized_pnl_usd,
    totalVolumeUsd: row.total_volume_usd,
    predictionsCount: row.predictions_count,
    correctPredictions: row.correct_predictions,
    wrongPredictions: row.wrong_predictions,
    totalActiveContracts: row.total_active_contracts,
    totalActiveContractsMicro: row.total_active_contracts_micro,
    totalPositionsValueUsd: row.total_positions_value_usd,
    snapshotAt: row.snapshot_at,
  };
}
