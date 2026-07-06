/**
 * One-shot ingestion: fetch `/trades` once, normalize, upsert, record the
 * run. No loop, no scheduling, no retries — a single pass. See
 * `src/backend/jobs/ingestTradesOnce.ts` for the CLI entry point that calls
 * this (`npm run ingest:trades:once`).
 */
import type { JupiterPredictionClientOptions } from '../services/jupiterPredictionClient.js';
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { normalizeTrade } from '../core/normalizeTrade.js';
import { upsertTrades, countTrades } from '../db/repositories/tradesRepository.js';
import {
  startIngestionRun,
  finishIngestionRun,
} from '../db/repositories/ingestionRunsRepository.js';

const ENDPOINT_NAME = 'trades';

export interface IngestTradesOnceResult {
  runId: number;
  fetched: number;
  upserted: number;
  duplicates: number;
  totalTradesInDb: number;
  durationMs: number;
}

function clientOptionsFromEnv(): JupiterPredictionClientOptions {
  const options: JupiterPredictionClientOptions = {};
  const baseUrl = process.env['JUPITER_PREDICTION_BASE_URL'];
  const apiKey = process.env['JUPITER_API_KEY'];
  if (baseUrl) options.baseUrl = baseUrl;
  if (apiKey) options.apiKey = apiKey;
  return options;
}

export async function ingestTradesOnce(
  client: JupiterPredictionClient = new JupiterPredictionClient(clientOptionsFromEnv()),
): Promise<IngestTradesOnceResult> {
  const startedAt = Date.now();
  // Created first (and deliberately before the network call): this also
  // means a missing DATABASE_URL fails loudly before any API request is
  // made, not after.
  const runId = await startIngestionRun(ENDPOINT_NAME);

  try {
    const rawTrades = await client.getTrades();
    const observedAt = new Date();
    const inputs = rawTrades.map((raw) => ({ trade: normalizeTrade(raw, observedAt), raw }));

    const upserted = await upsertTrades(inputs);
    const duplicates = inputs.length - upserted;
    const totalTradesInDb = await countTrades();
    const durationMs = Date.now() - startedAt;

    await finishIngestionRun(runId, {
      status: 'success',
      rowsFetched: rawTrades.length,
      rowsUpserted: upserted,
      errorMessage: null,
    });

    console.log(
      `[ingest:trades] fetched=${rawTrades.length} new=${upserted} duplicates=${duplicates} ` +
        `totalInDb=${totalTradesInDb} durationMs=${durationMs} runId=${runId}`,
    );

    return { runId, fetched: rawTrades.length, upserted, duplicates, totalTradesInDb, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    await finishIngestionRun(runId, {
      status: 'error',
      rowsFetched: null,
      rowsUpserted: null,
      errorMessage: message,
    }).catch((finishErr: unknown) => {
      console.error('[ingest:trades] also failed to record run failure', finishErr);
    });

    console.error(`[ingest:trades] failed after ${durationMs}ms (runId=${runId}):`, message);
    throw err;
  }
}
