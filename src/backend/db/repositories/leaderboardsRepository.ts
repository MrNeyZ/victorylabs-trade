/**
 * Data-access layer for the `leaderboard_snapshots` table. No business
 * logic here — just SQL. Callers are responsible for normalization
 * (`../../core/normalizeLeaderboardRow.ts`) and for bucketing
 * `snapshotAt` (`../../ingestion/ingestLeaderboards.ts`).
 */
import { getPool } from '../client.js';
import type { LeaderboardPeriod, LeaderboardSnapshot } from '../../types/domain.js';
import type { JupiterLeaderboardEntry } from '../../types/jupiter.js';

export interface LeaderboardSnapshotUpsertInput {
  snapshot: LeaderboardSnapshot;
  /** Full upstream payload, stored verbatim in the `raw` JSONB column. */
  raw: JupiterLeaderboardEntry;
}

const COLUMNS = [
  'wallet_pubkey',
  'period',
  'rank',
  'realized_pnl_usd',
  'total_volume_usd',
  'predictions_count',
  'correct_predictions',
  'wrong_predictions',
  'win_rate_pct',
  'period_start',
  'period_end',
  'raw',
  'snapshot_at',
] as const;

function toRowValues({ snapshot, raw }: LeaderboardSnapshotUpsertInput): unknown[] {
  return [
    snapshot.walletPubkey,
    snapshot.period,
    snapshot.rank,
    snapshot.realizedPnlUsd,
    snapshot.totalVolumeUsd,
    snapshot.predictionsCount,
    snapshot.correctPredictions,
    snapshot.wrongPredictions,
    snapshot.winRatePct,
    snapshot.periodStart,
    snapshot.periodEnd,
    JSON.stringify(raw),
    snapshot.snapshotAt,
  ];
}

/**
 * Bulk upsert, keyed by `(wallet_pubkey, period, snapshot_at)`. A snapshot
 * row is immutable once recorded for its bucket — re-ingesting within the
 * same bucket window is `ON CONFLICT DO NOTHING`, exactly like
 * trades/history. Returns the number of NEW rows actually inserted.
 */
export async function upsertLeaderboardSnapshots(
  inputs: LeaderboardSnapshotUpsertInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;

  const pool = getPool();
  const valuesSql: string[] = [];
  const params: unknown[] = [];

  inputs.forEach((input, rowIndex) => {
    const rowValues = toRowValues(input);
    const placeholders = rowValues.map(
      (_, colIndex) => `$${rowIndex * rowValues.length + colIndex + 1}`,
    );
    valuesSql.push(`(${placeholders.join(', ')})`);
    params.push(...rowValues);
  });

  const sql = `
    INSERT INTO leaderboard_snapshots (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (wallet_pubkey, period, snapshot_at) DO NOTHING
    RETURNING id
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

export async function countLeaderboardSnapshots(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM leaderboard_snapshots',
  );
  return Number(result.rows[0]?.count ?? '0');
}

interface LeaderboardSnapshotRow {
  wallet_pubkey: string;
  period: LeaderboardPeriod;
  rank: number | null;
  realized_pnl_usd: string;
  total_volume_usd: string;
  predictions_count: number;
  correct_predictions: number;
  wrong_predictions: number;
  win_rate_pct: string;
  period_start: Date | null;
  period_end: Date | null;
  snapshot_at: Date;
}

function rowToLeaderboardSnapshot(row: LeaderboardSnapshotRow): LeaderboardSnapshot {
  return {
    walletPubkey: row.wallet_pubkey,
    period: row.period,
    rank: row.rank,
    realizedPnlUsd: row.realized_pnl_usd,
    totalVolumeUsd: row.total_volume_usd,
    predictionsCount: row.predictions_count,
    correctPredictions: row.correct_predictions,
    wrongPredictions: row.wrong_predictions,
    winRatePct: row.win_rate_pct,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    snapshotAt: row.snapshot_at,
  };
}

export interface LatestLeaderboardSnapshotResult {
  period: LeaderboardPeriod;
  /** `null` when no snapshot has ever been ingested for this period. */
  snapshotAt: Date | null;
  rows: LeaderboardSnapshot[];
}

/**
 * Read path for the API layer (`GET /api/leaderboards/latest`). Finds the
 * most recent `snapshot_at` bucket for the given period (via a subquery,
 * backed by `idx_leaderboard_snapshots_period_snapshot_at`) and returns
 * every row in that bucket, ordered by rank.
 */
export async function getLatestLeaderboardSnapshot(
  period: LeaderboardPeriod,
): Promise<LatestLeaderboardSnapshotResult> {
  const pool = getPool();
  const result = await pool.query<LeaderboardSnapshotRow>(
    `SELECT wallet_pubkey, period, rank, realized_pnl_usd, total_volume_usd, predictions_count,
            correct_predictions, wrong_predictions, win_rate_pct, period_start, period_end, snapshot_at
     FROM leaderboard_snapshots
     WHERE period = $1 AND snapshot_at = (
       SELECT MAX(snapshot_at) FROM leaderboard_snapshots WHERE period = $1
     )
     ORDER BY rank ASC NULLS LAST`,
    [period],
  );

  const rows = result.rows.map(rowToLeaderboardSnapshot);
  return {
    period,
    snapshotAt: rows[0]?.snapshotAt ?? null,
    rows,
  };
}
