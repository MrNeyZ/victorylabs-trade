/**
 * Data-access layer for the `smart_money_signals` table. No detection
 * logic here — just SQL. Callers are responsible for running the pure
 * detector (`../../analytics/signals/detectSmartMoneySignals.ts`) and
 * handing over its output.
 */
import { getPool } from '../client.js';
import type {
  Signal,
  SignalSeverity,
  SignalType,
} from '../../analytics/signals/detectSmartMoneySignals.js';

const COLUMNS = [
  'id',
  'type',
  'severity',
  'wallet_pubkeys',
  'market_id',
  'side',
  'event_title',
  'amount_usd',
  'score_context',
  'occurred_at',
  'explanation',
  'raw',
] as const;

function toRowValues(signal: Signal): unknown[] {
  return [
    signal.id,
    signal.type,
    signal.severity,
    signal.walletPubkeys,
    signal.marketId,
    signal.side,
    signal.eventTitle,
    signal.amountUsd,
    JSON.stringify(signal.scoreContext),
    signal.occurredAt,
    signal.explanation,
    JSON.stringify(signal),
  ];
}

/**
 * Bulk insert, keyed by the detector's own deterministic `id` (see
 * `004_smart_money_signals.sql`). A persisted signal is immutable once
 * recorded — re-persisting the same detected signal (e.g. two
 * `analytics:signals:persist` runs with overlapping lookback windows) is
 * `ON CONFLICT DO NOTHING`, exactly like `trades`/`history_events`.
 * Returns the number of NEW rows actually inserted.
 */
export async function upsertSignals(signals: Signal[]): Promise<number> {
  if (signals.length === 0) return 0;

  const pool = getPool();
  const valuesSql: string[] = [];
  const params: unknown[] = [];

  signals.forEach((signal, rowIndex) => {
    const rowValues = toRowValues(signal);
    const placeholders = rowValues.map(
      (_, colIndex) => `$${rowIndex * rowValues.length + colIndex + 1}`,
    );
    valuesSql.push(`(${placeholders.join(', ')})`);
    params.push(...rowValues);
  });

  const sql = `
    INSERT INTO smart_money_signals (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

interface SignalRow {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  wallet_pubkeys: string[];
  market_id: string | null;
  side: 'yes' | 'no' | null;
  event_title: string | null;
  amount_usd: string | null;
  score_context: Signal['scoreContext'];
  occurred_at: Date;
  explanation: string;
}

/**
 * The read-side shape. Deliberately NOT the analytics `Signal` type
 * (`marketId: string`, `side: TradeSide`, `amountUsd: string`, all
 * non-null there) — `market_id`/`side`/`amount_usd` are nullable columns
 * (see `004_smart_money_signals.sql`'s doc comment on why), and every
 * signal type detected so far always populates them, but forcing a fake
 * placeholder value here on the (currently impossible) `NULL` case would
 * be more misleading than an honest `null` in the response.
 */
export interface PersistedSignal {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  walletPubkeys: string[];
  marketId: string | null;
  side: 'yes' | 'no' | null;
  eventTitle: string | null;
  amountUsd: string | null;
  scoreContext: Signal['scoreContext'];
  occurredAt: Date;
  explanation: string;
}

/**
 * Rebuilt from the persisted columns, NOT from `raw` — `raw` is kept as
 * a safety-net snapshot of the exact object that was persisted (see
 * migration doc comment), but the columns are the source of truth for
 * reads, same convention every other repository in this project follows
 * (`raw` is written, never read back, elsewhere).
 */
function rowToPersistedSignal(row: SignalRow): PersistedSignal {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    walletPubkeys: row.wallet_pubkeys,
    marketId: row.market_id,
    side: row.side,
    eventTitle: row.event_title,
    amountUsd: row.amount_usd,
    scoreContext: row.score_context,
    occurredAt: row.occurred_at,
    explanation: row.explanation,
  };
}

const SELECT_COLUMNS = `id, type, severity, wallet_pubkeys, market_id, side, event_title,
                         amount_usd, score_context, occurred_at, explanation`;

export interface GetRecentSignalsOptions {
  /** Only signals with `occurred_at` within the last N minutes. Omit for no time filter. */
  lookbackMinutes?: number;
  /** Default 50. */
  limit?: number;
  type?: SignalType;
  severity?: SignalSeverity;
  marketId?: string;
}

/**
 * Read path for the API layer (`GET /api/signals/recent?source=persisted`,
 * the default). Ordered by `occurred_at` descending, matching the pure
 * detector's own sort order so persisted and live reads are directly
 * comparable.
 */
export async function getRecentSignals(
  options: GetRecentSignalsOptions = {},
): Promise<PersistedSignal[]> {
  const limit = options.limit ?? 50;
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.lookbackMinutes !== undefined) {
    params.push(options.lookbackMinutes);
    conditions.push(`occurred_at >= now() - make_interval(mins => $${params.length})`);
  }
  if (options.type !== undefined) {
    params.push(options.type);
    conditions.push(`type = $${params.length}`);
  }
  if (options.severity !== undefined) {
    params.push(options.severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (options.marketId !== undefined) {
    params.push(options.marketId);
    conditions.push(`market_id = $${params.length}`);
  }

  params.push(limit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<SignalRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM smart_money_signals
     ${whereClause}
     ORDER BY occurred_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(rowToPersistedSignal);
}

export interface WalletSignalCounts {
  walletPubkey: string;
  whaleTradeCount: number;
  marketConsensusCount: number;
}

interface WalletSignalCountRow {
  wallet_pubkey: string;
  type: SignalType;
  signal_count: string;
}

/**
 * Trending-wallet read path (`src/backend/analytics/trending/`, Phase
 * 4.1) — for a given set of wallets, how many `whale_trade` and
 * `market_consensus` signals each appeared in within `lookbackMinutes`.
 * `wallet_pubkeys` is an array column (one signal can name several
 * wallets, e.g. `market_consensus`), so this expands it with `unnest`
 * and correlates against the requested pubkeys; the `&&` overlap check
 * lets Postgres use the GIN index on `wallet_pubkeys`
 * (`idx_smart_money_signals_wallet_pubkeys`) before unnesting, rather
 * than unnesting every signal in the window first.
 *
 * Wallets with zero of either type are still present in the result with
 * both counts at `0`, not omitted — callers shouldn't need a fallback
 * default for a wallet that simply has no whale/consensus signals.
 */
export async function getWalletSignalCounts(
  walletPubkeys: string[],
  lookbackMinutes: number,
): Promise<WalletSignalCounts[]> {
  if (walletPubkeys.length === 0) return [];

  const countsByWallet = new Map<string, WalletSignalCounts>(
    walletPubkeys.map((walletPubkey) => [
      walletPubkey,
      { walletPubkey, whaleTradeCount: 0, marketConsensusCount: 0 },
    ]),
  );

  const pool = getPool();
  const result = await pool.query<WalletSignalCountRow>(
    `SELECT unnested.wallet_pubkey, s.type, COUNT(*)::text AS signal_count
     FROM smart_money_signals s
     CROSS JOIN LATERAL unnest(s.wallet_pubkeys) AS unnested(wallet_pubkey)
     WHERE s.wallet_pubkeys && $1::text[]
       AND unnested.wallet_pubkey = ANY($1)
       AND s.type = ANY($2)
       AND s.occurred_at >= now() - make_interval(mins => $3)
     GROUP BY unnested.wallet_pubkey, s.type`,
    [walletPubkeys, ['whale_trade', 'market_consensus'], lookbackMinutes],
  );

  for (const row of result.rows) {
    const entry = countsByWallet.get(row.wallet_pubkey);
    if (!entry) continue;
    if (row.type === 'whale_trade') entry.whaleTradeCount = Number(row.signal_count);
    if (row.type === 'market_consensus') entry.marketConsensusCount = Number(row.signal_count);
  }

  return Array.from(countsByWallet.values());
}

export interface MarketSignalCounts {
  marketId: string;
  whaleTradeCount: number;
  marketConsensusCount: number;
}

interface MarketSignalCountRow {
  market_id: string;
  type: SignalType;
  signal_count: string;
}

/**
 * Trending-market read path (`src/backend/analytics/trendingMarkets/`,
 * Phase 4.2) — the market-scoped counterpart to
 * `getWalletSignalCounts`. Simpler than that function: `market_id` is a
 * plain scalar column (unlike `wallet_pubkeys`, an array), so this is a
 * direct `GROUP BY`, no `unnest`/overlap check needed.
 *
 * Markets with zero of either type are still present in the result with
 * both counts at `0`, same "no fallback needed at the call site"
 * convention `getWalletSignalCounts` follows.
 */
export async function getMarketSignalCounts(
  marketIds: string[],
  lookbackMinutes: number,
): Promise<MarketSignalCounts[]> {
  if (marketIds.length === 0) return [];

  const countsByMarket = new Map<string, MarketSignalCounts>(
    marketIds.map((marketId) => [
      marketId,
      { marketId, whaleTradeCount: 0, marketConsensusCount: 0 },
    ]),
  );

  const pool = getPool();
  const result = await pool.query<MarketSignalCountRow>(
    `SELECT market_id, type, COUNT(*)::text AS signal_count
     FROM smart_money_signals
     WHERE market_id = ANY($1)
       AND type = ANY($2)
       AND occurred_at >= now() - make_interval(mins => $3)
     GROUP BY market_id, type`,
    [marketIds, ['whale_trade', 'market_consensus'], lookbackMinutes],
  );

  for (const row of result.rows) {
    const entry = countsByMarket.get(row.market_id);
    if (!entry) continue;
    if (row.type === 'whale_trade') entry.whaleTradeCount = Number(row.signal_count);
    if (row.type === 'market_consensus') entry.marketConsensusCount = Number(row.signal_count);
  }

  return Array.from(countsByMarket.values());
}
