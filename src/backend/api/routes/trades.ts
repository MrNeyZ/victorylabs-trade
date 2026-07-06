/**
 * GET /api/trades/recent  — one-shot, filterable recent-trades snapshot.
 * GET /api/trades/stream  — same filters, but as a live SSE feed.
 *
 * Both are read-only against Postgres (never a live upstream call) and
 * never trigger ingestion — they only ever see whatever the ingestion
 * jobs (`src/backend/jobs/ingest*.ts`) already wrote.
 */
import { Router } from 'express';
import {
  getRecentTrades,
  getTradesSince,
  type GetRecentTradesOptions,
  type GetTradesSinceOptions,
} from '../../db/repositories/tradesRepository.js';
import { firstQueryString, parseLimitParam, type ParseLimitResult } from '../queryParams.js';

export const tradesRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STREAM_POLL_INTERVAL_MS = 5_000;
const STREAM_HEARTBEAT_INTERVAL_MS = 25_000;

interface TradeFilters {
  marketId: string | undefined;
  ownerPubkey: string | undefined;
}

function parseTradeFilters(query: Record<string, unknown>): TradeFilters {
  return {
    marketId: firstQueryString(query['marketId']),
    ownerPubkey: firstQueryString(query['ownerPubkey']),
  };
}

function buildRecentTradesOptions(limit: number, filters: TradeFilters): GetRecentTradesOptions {
  const options: GetRecentTradesOptions = { limit };
  if (filters.marketId !== undefined) options.marketId = filters.marketId;
  if (filters.ownerPubkey !== undefined) options.ownerPubkey = filters.ownerPubkey;
  return options;
}

function buildTradesSinceOptions(filters: TradeFilters): GetTradesSinceOptions {
  const options: GetTradesSinceOptions = {};
  if (filters.marketId !== undefined) options.marketId = filters.marketId;
  if (filters.ownerPubkey !== undefined) options.ownerPubkey = filters.ownerPubkey;
  return options;
}

tradesRouter.get('/recent', async (req, res) => {
  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const filters = parseTradeFilters(req.query as Record<string, unknown>);
  const trades = await getRecentTrades(buildRecentTradesOptions(limitResult.value, filters));
  res.json({ data: trades });
});

/**
 * SSE trade stream:
 *   1. Sends an initial `snapshot` event (same shape/filters as
 *      `/recent`) immediately on connect.
 *   2. Polls Postgres every 5s for trades with `observed_at` after the
 *      last one sent, emitting one `trade` event per new row.
 *   3. Sends a `heartbeat` event every 25s so a proxy/client can detect a
 *      silently-dead connection even when no new trades are arriving.
 *   4. Cleans up both timers on client disconnect (`req`/`res` `close`).
 *
 * The initial snapshot query happens BEFORE any SSE header is written,
 * so a DB failure there still produces a normal JSON 500 via Express 5's
 * automatic async-error forwarding, rather than a half-open stream.
 */
tradesRouter.get('/stream', async (req, res) => {
  const limitResult: ParseLimitResult = parseLimitParam(
    req.query['limit'],
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const filters = parseTradeFilters(req.query as Record<string, unknown>);
  const snapshotTrades = await getRecentTrades(
    buildRecentTradesOptions(limitResult.value, filters),
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('snapshot', { trades: snapshotTrades });

  // Cursor = newest observedAt among what's already been sent. Starts at
  // epoch if the snapshot was empty, so the very first poll can pick up
  // anything that exists at all.
  let cursor = snapshotTrades.reduce<Date>(
    (max, trade) => (trade.observedAt > max ? trade.observedAt : max),
    new Date(0),
  );
  let closed = false;
  let pollTimer: NodeJS.Timeout | undefined;

  const sinceOptions = buildTradesSinceOptions(filters);

  // Self-scheduling setTimeout, not setInterval: the next poll is only
  // scheduled once the current one finishes, so a slow query can never
  // cause overlapping DB calls to pile up (same lesson already applied
  // in scripts/validate-rest-api.mjs's polling loops).
  const runPoll = async (): Promise<void> => {
    try {
      const newTrades = await getTradesSince(cursor, sinceOptions);
      for (const trade of newTrades) {
        sendEvent('trade', trade);
        if (trade.observedAt > cursor) cursor = trade.observedAt;
      }
    } catch (err) {
      console.error('[api] SSE poll error on /api/trades/stream', err);
    }
  };

  const scheduleNextPoll = (): void => {
    if (closed) return;
    pollTimer = setTimeout(() => {
      void runPoll().finally(scheduleNextPoll);
    }, STREAM_POLL_INTERVAL_MS);
  };
  scheduleNextPoll();

  const heartbeatTimer = setInterval(() => {
    sendEvent('heartbeat', { ts: new Date().toISOString() });
  }, STREAM_HEARTBEAT_INTERVAL_MS);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(pollTimer);
    clearInterval(heartbeatTimer);
    console.log('[api] SSE client disconnected from /api/trades/stream — cleaned up');
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
});
