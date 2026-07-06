/**
 * Data-access layer for the `positions` table. No business logic here —
 * just SQL. Callers are responsible for normalization
 * (`../../core/normalizePosition.ts`).
 *
 * Unlike `trades`/`history_events`, this is a TRUE upsert
 * (`ON CONFLICT ... DO UPDATE`), not `DO NOTHING` — a position's PnL,
 * value, and claimed/settlement state genuinely change over its
 * lifecycle, and `positions` is documented (see `001_init.sql`) as
 * holding only the latest known state per position, not a history.
 */
import { getPool } from '../client.js';
import type { Position } from '../../types/domain.js';
import type { JupiterPosition } from '../../types/jupiter.js';

export interface PositionUpsertInput {
  position: Position;
  /** Full upstream payload, stored verbatim in the `raw` JSONB column. */
  raw: JupiterPosition;
}

const COLUMNS = [
  'position_pubkey',
  'owner_pubkey',
  'market_id',
  'event_id',
  'is_yes',
  'side_label',
  'contracts_micro',
  'total_cost_usd',
  'value_usd',
  'avg_price_usd',
  'mark_price_usd',
  'pnl_usd',
  'pnl_usd_after_fees',
  'realized_pnl_usd',
  'fees_paid_usd',
  'claimed',
  'claimed_usd',
  'claimable',
  'payout_usd',
  'lifecycle_status',
  'opened_at',
  'updated_at',
  'claimable_at',
  'settlement_date',
  'raw',
  'observed_at',
] as const;

const UPDATE_COLUMNS = COLUMNS.filter((column) => column !== 'position_pubkey');

function toRowValues({ position, raw }: PositionUpsertInput): unknown[] {
  return [
    position.positionPubkey,
    position.ownerPubkey,
    position.marketId,
    position.eventId,
    position.isYes,
    position.sideLabel,
    position.contractsMicro,
    position.totalCostUsd,
    position.valueUsd,
    position.avgPriceUsd,
    position.markPriceUsd,
    position.pnlUsd,
    position.pnlUsdAfterFees,
    position.realizedPnlUsd,
    position.feesPaidUsd,
    position.claimed,
    position.claimedUsd,
    position.claimable,
    position.payoutUsd,
    position.lifecycleStatus,
    position.openedAt,
    position.updatedAt,
    position.claimableAt,
    position.settlementDate,
    JSON.stringify(raw),
    position.observedAt,
  ];
}

/**
 * Bulk upsert, keyed by upstream `pubkey` (`position_pubkey`). Returns the
 * number of rows affected (inserted OR updated) — unlike the `DO NOTHING`
 * repositories, every row here always affects one row one way or another,
 * so this number is fetched-count, not a "how many were genuinely new"
 * count (there's no equivalent "duplicate" concept for a true upsert).
 */
export async function upsertPositions(inputs: PositionUpsertInput[]): Promise<number> {
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

  const updateSet = UPDATE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ');

  const sql = `
    INSERT INTO positions (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (position_pubkey) DO UPDATE SET ${updateSet}
    RETURNING position_pubkey
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

export async function countPositions(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM positions',
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function getPositionsForWallet(ownerPubkey: string): Promise<Position[]> {
  const pool = getPool();
  const result = await pool.query<{
    position_pubkey: string;
    owner_pubkey: string;
    market_id: string;
    event_id: string | null;
    is_yes: boolean | null;
    side_label: 'Up' | 'Down' | null;
    contracts_micro: string | null;
    total_cost_usd: string | null;
    value_usd: string | null;
    avg_price_usd: string | null;
    mark_price_usd: string | null;
    pnl_usd: string | null;
    pnl_usd_after_fees: string | null;
    realized_pnl_usd: string | null;
    fees_paid_usd: string | null;
    claimed: boolean | null;
    claimed_usd: string | null;
    claimable: boolean | null;
    payout_usd: string | null;
    lifecycle_status: 'open' | 'resolving' | 'settled' | null;
    opened_at: Date | null;
    updated_at: Date | null;
    claimable_at: Date | null;
    settlement_date: Date | null;
    observed_at: Date;
  }>('SELECT * FROM positions WHERE owner_pubkey = $1 ORDER BY updated_at DESC NULLS LAST', [
    ownerPubkey,
  ]);

  return result.rows.map((row) => ({
    positionPubkey: row.position_pubkey,
    ownerPubkey: row.owner_pubkey,
    marketId: row.market_id,
    eventId: row.event_id,
    isYes: row.is_yes,
    sideLabel: row.side_label,
    contractsMicro: row.contracts_micro,
    totalCostUsd: row.total_cost_usd,
    valueUsd: row.value_usd,
    avgPriceUsd: row.avg_price_usd,
    markPriceUsd: row.mark_price_usd,
    pnlUsd: row.pnl_usd,
    pnlUsdAfterFees: row.pnl_usd_after_fees,
    realizedPnlUsd: row.realized_pnl_usd,
    feesPaidUsd: row.fees_paid_usd,
    claimed: row.claimed,
    claimedUsd: row.claimed_usd,
    claimable: row.claimable,
    payoutUsd: row.payout_usd,
    lifecycleStatus: row.lifecycle_status,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    claimableAt: row.claimable_at,
    settlementDate: row.settlement_date,
    observedAt: row.observed_at,
  }));
}
