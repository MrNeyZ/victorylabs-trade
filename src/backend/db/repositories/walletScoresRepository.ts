/**
 * Data-access layer for the `wallet_score_snapshots` table. No scoring
 * logic here — just SQL. Callers are responsible for computing
 * `WalletStats`/`WalletScore` (`../../analytics/`) and for bucketing
 * `snapshotAt` (`../../jobs/computeWalletScores.ts`).
 */
import { getPool } from '../client.js';
import type { WalletScore, WalletScoreTier } from '../../analytics/scoring/computeWalletScore.js';
import type { WalletStats } from '../../analytics/walletStats/computeWalletStats.js';

export interface WalletScoreSnapshotInsertInput {
  walletScore: WalletScore;
  /** The `WalletStats` the score was computed from, stored verbatim in the `stats` JSONB column. */
  stats: WalletStats;
  snapshotAt: Date;
}

const COLUMNS = [
  'wallet_pubkey',
  'snapshot_at',
  'score',
  'tier',
  'profitability',
  'consistency',
  'activity',
  'recency',
  'sample_size',
  'explanation',
  'stats',
] as const;

function toRowValues({
  walletScore,
  stats,
  snapshotAt,
}: WalletScoreSnapshotInsertInput): unknown[] {
  return [
    walletScore.walletPubkey,
    snapshotAt,
    walletScore.score,
    walletScore.tier,
    walletScore.components.profitability,
    walletScore.components.consistency,
    walletScore.components.activity,
    walletScore.components.recency,
    walletScore.components.sampleSize,
    JSON.stringify(walletScore.explanations),
    JSON.stringify(stats),
  ];
}

/**
 * Bulk insert, keyed by `(wallet_pubkey, snapshot_at)`. A snapshot row is
 * immutable once recorded for its bucket — re-running the scoring job
 * within the same 5-minute bucket is `ON CONFLICT DO NOTHING`, exactly
 * like `leaderboard_snapshots`. Returns the number of NEW rows actually
 * inserted.
 */
export async function insertWalletScoreSnapshots(
  inputs: WalletScoreSnapshotInsertInput[],
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
    INSERT INTO wallet_score_snapshots (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (wallet_pubkey, snapshot_at) DO NOTHING
    RETURNING id
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

interface WalletScoreSnapshotRow {
  wallet_pubkey: string;
  snapshot_at: Date;
  score: number;
  tier: WalletScoreTier;
  profitability: number;
  consistency: number;
  activity: number;
  recency: number;
  sample_size: number;
  explanation: string[];
  stats: WalletStats;
}

export interface WalletScoreSnapshotResult {
  walletPubkey: string;
  snapshotAt: Date;
  score: number;
  tier: WalletScoreTier;
  components: {
    profitability: number;
    consistency: number;
    activity: number;
    recency: number;
    sampleSize: number;
  };
  explanations: string[];
  stats: WalletStats;
}

function rowToResult(row: WalletScoreSnapshotRow): WalletScoreSnapshotResult {
  return {
    walletPubkey: row.wallet_pubkey,
    snapshotAt: row.snapshot_at,
    score: row.score,
    tier: row.tier,
    components: {
      profitability: row.profitability,
      consistency: row.consistency,
      activity: row.activity,
      recency: row.recency,
      sampleSize: row.sample_size,
    },
    explanations: row.explanation,
    stats: row.stats,
  };
}

const SELECT_COLUMNS = `wallet_pubkey, snapshot_at, score, tier, profitability, consistency,
                         activity, recency, sample_size, explanation, stats`;

export interface GetLatestWalletScoresOptions {
  /** Default 50. */
  limit?: number;
  tier?: WalletScoreTier;
  minScore?: number;
}

export interface LatestWalletScoresResult {
  /** `null` when no snapshot has ever been ingested. */
  snapshotAt: Date | null;
  rows: WalletScoreSnapshotResult[];
}

const DEFAULT_LATEST_LIMIT = 50;

/**
 * Read path for the API layer (`GET /api/scores/latest`). Finds the most
 * recent `snapshot_at` bucket across all wallets (via a subquery, backed
 * by `idx_wallet_score_snapshots_snapshot_at`), optionally filters by
 * `tier`/`minScore` within that bucket, and returns rows ordered by score
 * descending.
 */
export async function getLatestWalletScores(
  options: GetLatestWalletScoresOptions = {},
): Promise<LatestWalletScoresResult> {
  const pool = getPool();
  const limit = options.limit ?? DEFAULT_LATEST_LIMIT;

  const conditions: string[] = [
    'snapshot_at = (SELECT MAX(snapshot_at) FROM wallet_score_snapshots)',
  ];
  const params: unknown[] = [];

  if (options.tier !== undefined) {
    params.push(options.tier);
    conditions.push(`tier = $${params.length}`);
  }
  if (options.minScore !== undefined) {
    params.push(options.minScore);
    conditions.push(`score >= $${params.length}`);
  }

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  const result = await pool.query<WalletScoreSnapshotRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM wallet_score_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY score DESC
     LIMIT ${limitPlaceholder}`,
    params,
  );

  const rows = result.rows.map(rowToResult);
  return {
    snapshotAt: rows[0]?.snapshotAt ?? null,
    rows,
  };
}

/**
 * Full snapshot history for one wallet, newest first. The read path for
 * `GET /api/wallets/:walletPubkey`'s `latestSmartScore` field is just
 * `(await getWalletScoreHistory(walletPubkey))[0] ?? null`.
 */
export async function getWalletScoreHistory(
  walletPubkey: string,
): Promise<WalletScoreSnapshotResult[]> {
  const pool = getPool();
  const result = await pool.query<WalletScoreSnapshotRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM wallet_score_snapshots
     WHERE wallet_pubkey = $1
     ORDER BY snapshot_at DESC`,
    [walletPubkey],
  );
  return result.rows.map(rowToResult);
}
