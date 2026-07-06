/**
 * One-shot ingestion: fetch all 3 leaderboard periods once, normalize,
 * upsert into `leaderboard_snapshots`, record the run.
 *
 * Two assumptions specific to this file, documented here rather than left
 * implicit:
 *   - Fetches `metric=pnl` for all three periods — a single, consistent
 *     choice for what `rank` means (rank by realized PnL), matching this
 *     project's smart-money thesis. Upstream also supports `volume`/
 *     `win_rate` sort metrics; not fetched here.
 *   - `snapshotAt` is floored to a 5-minute bucket (`SNAPSHOT_BUCKET_MS`)
 *     BEFORE normalizing any row, and the same bucketed value is reused
 *     across all 3 periods in one call. This is what makes two ingestion
 *     runs within the same 5-minute window collide on
 *     `(wallet_pubkey, period, snapshot_at)` and get skipped, instead of
 *     each run creating a new near-duplicate row — this project's own
 *     idempotency mechanism, not an upstream concept.
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import type { JupiterLeaderboardPeriod } from '../types/jupiter.js';
import { normalizeLeaderboardRow } from '../core/normalizeLeaderboardRow.js';
import { upsertLeaderboardSnapshots } from '../db/repositories/leaderboardsRepository.js';
import {
  startIngestionRun,
  finishIngestionRun,
} from '../db/repositories/ingestionRunsRepository.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';
import { floorToBucket, sleep } from '../utils/time.js';

const ENDPOINT_NAME = 'leaderboards';
const ALL_PERIODS: JupiterLeaderboardPeriod[] = ['all_time', 'weekly', 'monthly'];

export const SNAPSHOT_BUCKET_MS = 5 * 60 * 1000;

/**
 * Spacing between the 3 sequential period calls below — not retry/backoff
 * logic, just simple pacing to stay under the documented keyless rate
 * limit (~0.5-1.25 req/s, see docs/jupiter-prediction-discovery.md §7.3
 * and docs/rest-api-capabilities.md §4) instead of bursting all 3 calls
 * back to back.
 */
const INTER_REQUEST_DELAY_MS = 1100;

interface PeriodStats {
  fetched: number;
  upserted: number;
}

export interface IngestLeaderboardsResult {
  runId: number;
  snapshotAt: Date;
  fetched: number;
  upserted: number;
  duplicates: number;
  perPeriod: Record<JupiterLeaderboardPeriod, PeriodStats>;
  /** All-time wallets in rank order (rank 1 first) — reused by ingestRankings.ts to pick the top N without a redundant API call. */
  allTimeWallets: string[];
  durationMs: number;
}

export async function ingestLeaderboards(
  client: JupiterPredictionClient = new JupiterPredictionClient(clientOptionsFromEnv()),
): Promise<IngestLeaderboardsResult> {
  const startedAt = Date.now();
  const runId = await startIngestionRun(ENDPOINT_NAME);

  try {
    const snapshotAt = floorToBucket(new Date(), SNAPSHOT_BUCKET_MS);
    let fetched = 0;
    let upserted = 0;
    let allTimeWallets: string[] = [];
    const perPeriod: Record<JupiterLeaderboardPeriod, PeriodStats> = {
      all_time: { fetched: 0, upserted: 0 },
      weekly: { fetched: 0, upserted: 0 },
      monthly: { fetched: 0, upserted: 0 },
    };

    for (const [index, period] of ALL_PERIODS.entries()) {
      if (index > 0) await sleep(INTER_REQUEST_DELAY_MS);
      const rows = await client.getLeaderboards({ period, metric: 'pnl' });
      const inputs = rows.map((raw, index) => ({
        snapshot: normalizeLeaderboardRow(raw, index + 1, snapshotAt),
        raw,
      }));
      const periodUpserted = await upsertLeaderboardSnapshots(inputs);

      fetched += rows.length;
      upserted += periodUpserted;
      perPeriod[period] = { fetched: rows.length, upserted: periodUpserted };
      if (period === 'all_time') {
        allTimeWallets = rows.map((row) => row.ownerPubkey);
      }
    }

    const duplicates = fetched - upserted;
    const durationMs = Date.now() - startedAt;

    await finishIngestionRun(runId, {
      status: 'success',
      rowsFetched: fetched,
      rowsUpserted: upserted,
      errorMessage: null,
    });

    console.log(
      `[ingest:leaderboards] snapshotAt=${snapshotAt.toISOString()} fetched=${fetched} ` +
        `new=${upserted} duplicates=${duplicates} durationMs=${durationMs} runId=${runId}`,
    );

    return {
      runId,
      snapshotAt,
      fetched,
      upserted,
      duplicates,
      perPeriod,
      allTimeWallets,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    await finishIngestionRun(runId, {
      status: 'error',
      rowsFetched: null,
      rowsUpserted: null,
      errorMessage: message,
    }).catch((finishErr: unknown) => {
      console.error('[ingest:leaderboards] also failed to record run failure', finishErr);
    });

    console.error(`[ingest:leaderboards] failed after ${durationMs}ms (runId=${runId}):`, message);
    throw err;
  }
}
