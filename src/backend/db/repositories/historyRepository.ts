/**
 * Data-access layer for the `history_events` table. No business logic
 * here — just SQL. Callers are responsible for normalization
 * (`../../core/normalizeHistoryEvent.ts`).
 */
import { getPool } from '../client.js';
import type { HistoryEvent } from '../../types/domain.js';
import type { JupiterHistoryEventV1 } from '../../types/jupiter.js';

export interface HistoryEventUpsertInput {
  event: HistoryEvent;
  /** Full upstream payload, stored verbatim in the `raw` JSONB column. */
  raw: JupiterHistoryEventV1;
}

const COLUMNS = [
  'id',
  'owner_pubkey',
  'market_id',
  'position_pubkey',
  'action',
  'side',
  'event_title',
  'upstream_timestamp',
  'amount_usd',
  'price',
  'realized_pnl_usd',
  'transaction_signature',
  'raw',
  'observed_at',
] as const;

function toRowValues({ event, raw }: HistoryEventUpsertInput): unknown[] {
  return [
    event.id,
    event.ownerPubkey,
    event.marketId,
    event.positionPubkey,
    event.action,
    event.side,
    event.eventTitle,
    event.upstreamTimestamp,
    event.amountUsd,
    event.price,
    event.realizedPnlUsd,
    event.transactionSignature,
    JSON.stringify(raw),
    event.observedAt,
  ];
}

/**
 * Bulk upsert, keyed by upstream `id`. History events are immutable once
 * recorded upstream (same reasoning as `tradesRepository.upsertTrades`),
 * so this is `ON CONFLICT DO NOTHING`, not an update. Returns the number
 * of NEW rows actually inserted.
 */
export async function upsertHistoryEvents(inputs: HistoryEventUpsertInput[]): Promise<number> {
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
    INSERT INTO history_events (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

export async function countHistoryEvents(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM history_events',
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function getLatestHistoryTimestamp(ownerPubkey: string): Promise<Date | null> {
  const pool = getPool();
  const result = await pool.query<{ upstream_timestamp: Date | null }>(
    `SELECT upstream_timestamp
     FROM history_events
     WHERE owner_pubkey = $1
     ORDER BY upstream_timestamp DESC NULLS LAST
     LIMIT 1`,
    [ownerPubkey],
  );
  return result.rows[0]?.upstream_timestamp ?? null;
}

interface HistoryEventRow {
  id: string;
  owner_pubkey: string;
  market_id: string | null;
  position_pubkey: string | null;
  action: 'buy' | 'sell' | null;
  side: 'yes' | 'no' | null;
  event_title: string | null;
  upstream_timestamp: Date | null;
  amount_usd: string | null;
  price: string | null;
  realized_pnl_usd: string | null;
  transaction_signature: string | null;
  observed_at: Date;
}

function rowToHistoryEvent(row: HistoryEventRow): HistoryEvent {
  return {
    id: row.id,
    ownerPubkey: row.owner_pubkey,
    marketId: row.market_id,
    positionPubkey: row.position_pubkey,
    action: row.action,
    side: row.side,
    eventTitle: row.event_title,
    upstreamTimestamp: row.upstream_timestamp,
    amountUsd: row.amount_usd,
    price: row.price,
    realizedPnlUsd: row.realized_pnl_usd,
    transactionSignature: row.transaction_signature,
    observedAt: row.observed_at,
  };
}

/** Read path for the API layer (`GET /api/wallets/:walletPubkey`) — most-recent-first by upstream timestamp. */
export async function getRecentHistoryForWallet(
  ownerPubkey: string,
  limit = 50,
): Promise<HistoryEvent[]> {
  const pool = getPool();
  const result = await pool.query<HistoryEventRow>(
    `SELECT id, owner_pubkey, market_id, position_pubkey, action, side, event_title,
            upstream_timestamp, amount_usd, price, realized_pnl_usd, transaction_signature, observed_at
     FROM history_events
     WHERE owner_pubkey = $1
     ORDER BY upstream_timestamp DESC NULLS LAST
     LIMIT $2`,
    [ownerPubkey, limit],
  );
  return result.rows.map(rowToHistoryEvent);
}
