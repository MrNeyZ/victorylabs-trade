/**
 * Data-access layer for `GET /api/search` (Phase 5.1). Deliberately
 * queries `trades` directly rather than the `wallets`/`markets`
 * dimension tables (`001_init.sql`) — those two tables exist in the
 * schema but no ingestion job has ever written to them (confirmed empty
 * in production), so they're not a usable source of "every wallet/market
 * this project has seen." `trades` is the one table guaranteed to be
 * populated and to carry both identifiers.
 *
 * Both queries are intentionally NOT time-bounded — a wallet/market
 * that only traded days ago must still be findable by exact prefix/title
 * match; recency only affects *ranking* (`ORDER BY MAX(upstream_timestamp)
 * DESC`), not whether a row is a match at all. Candidate limits here are
 * a generous pre-rank pool (`gatherSearchInput.ts` cross-references
 * wallet scores before the final sort/truncate to the API's own 20-item
 * cap), not the final result count.
 */
import { getPool } from '../client.js';
import { escapeLikePattern } from '../../utils/sql.js';

export interface WalletSearchCandidate {
  walletPubkey: string;
  tradeCount: number;
  lastActivityAt: Date;
}

interface WalletSearchCandidateRow {
  owner_pubkey: string;
  trade_count: string;
  last_activity_at: Date;
}

/** Prefix match on `owner_pubkey` — matches the requirement's "search by prefix on wallet_pubkey" literally (not a substring/ILIKE match). */
export async function searchWalletsByPrefix(
  prefix: string,
  limit: number,
): Promise<WalletSearchCandidate[]> {
  const pool = getPool();
  const result = await pool.query<WalletSearchCandidateRow>(
    `SELECT owner_pubkey,
            COUNT(*)::text AS trade_count,
            MAX(upstream_timestamp) AS last_activity_at
     FROM trades
     WHERE owner_pubkey LIKE $1 ESCAPE '\\'
     GROUP BY owner_pubkey
     ORDER BY MAX(upstream_timestamp) DESC
     LIMIT $2`,
    [`${escapeLikePattern(prefix)}%`, limit],
  );

  return result.rows.map((row) => ({
    walletPubkey: row.owner_pubkey,
    tradeCount: Number(row.trade_count),
    lastActivityAt: row.last_activity_at,
  }));
}

export interface MarketSearchCandidate {
  marketId: string;
  eventTitle: string | null;
  tradeCount: number;
  lastActivityAt: Date;
}

interface MarketSearchCandidateRow {
  market_id: string;
  event_title: string | null;
  trade_count: string;
  last_activity_at: Date;
}

/** Prefix match on `market_id` OR substring (`ILIKE`) match on `event_title`, per the requirement's explicit "use ILIKE for event title." */
export async function searchMarkets(
  query: string,
  limit: number,
): Promise<MarketSearchCandidate[]> {
  const pool = getPool();
  const escaped = escapeLikePattern(query);
  const result = await pool.query<MarketSearchCandidateRow>(
    `SELECT market_id,
            (ARRAY_AGG(event_title ORDER BY upstream_timestamp DESC) FILTER (WHERE event_title IS NOT NULL))[1] AS event_title,
            COUNT(*)::text AS trade_count,
            MAX(upstream_timestamp) AS last_activity_at
     FROM trades
     WHERE market_id LIKE $1 ESCAPE '\\' OR event_title ILIKE $2 ESCAPE '\\'
     GROUP BY market_id
     ORDER BY MAX(upstream_timestamp) DESC
     LIMIT $3`,
    [`${escaped}%`, `%${escaped}%`, limit],
  );

  return result.rows.map((row) => ({
    marketId: row.market_id,
    eventTitle: row.event_title,
    tradeCount: Number(row.trade_count),
    lastActivityAt: row.last_activity_at,
  }));
}
