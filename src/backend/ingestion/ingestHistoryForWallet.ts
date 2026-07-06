/**
 * One-shot ingestion: fetch `/history` for a single wallet once, normalize,
 * upsert, record the run. Mirrors `ingestTradesOnce.ts`'s structure exactly,
 * parametrized by wallet.
 *
 * No pagination traversal yet — `/history` is genuinely paginated
 * (`{start, end, total, hasNext}`, unlike `/trades`), but this phase only
 * fetches the first page per wallet per call, matching the same
 * "validate against real data before building more" incremental approach
 * already used for trades. `paginationTotal` is returned/logged so a
 * future phase has the real numbers to decide whether/how to paginate.
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { normalizeHistoryEvent } from '../core/normalizeHistoryEvent.js';
import { upsertHistoryEvents, countHistoryEvents } from '../db/repositories/historyRepository.js';
import {
  startIngestionRun,
  finishIngestionRun,
} from '../db/repositories/ingestionRunsRepository.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

const ENDPOINT_NAME = 'history';

export interface IngestHistoryForWalletResult {
  runId: number;
  ownerPubkey: string;
  fetched: number;
  upserted: number;
  duplicates: number;
  totalHistoryEventsInDb: number;
  paginationTotal: number | null;
  durationMs: number;
}

export async function ingestHistoryForWallet(
  ownerPubkey: string,
  client: JupiterPredictionClient = new JupiterPredictionClient(clientOptionsFromEnv()),
): Promise<IngestHistoryForWalletResult> {
  const startedAt = Date.now();
  const runId = await startIngestionRun(ENDPOINT_NAME, { ownerPubkey });

  try {
    const response = await client.getHistory({ ownerPubkey });
    const observedAt = new Date();
    const inputs = response.data.map((raw) => ({
      event: normalizeHistoryEvent(raw, observedAt),
      raw,
    }));

    const upserted = await upsertHistoryEvents(inputs);
    const duplicates = inputs.length - upserted;
    const totalHistoryEventsInDb = await countHistoryEvents();
    const durationMs = Date.now() - startedAt;

    await finishIngestionRun(runId, {
      status: 'success',
      rowsFetched: response.data.length,
      rowsUpserted: upserted,
      errorMessage: null,
    });

    console.log(
      `[ingest:history] wallet=${ownerPubkey} fetched=${response.data.length} new=${upserted} ` +
        `duplicates=${duplicates} totalInDb=${totalHistoryEventsInDb} ` +
        `paginationTotal=${response.pagination.total} durationMs=${durationMs} runId=${runId}`,
    );

    return {
      runId,
      ownerPubkey,
      fetched: response.data.length,
      upserted,
      duplicates,
      totalHistoryEventsInDb,
      paginationTotal: response.pagination.total,
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
      console.error('[ingest:history] also failed to record run failure', finishErr);
    });

    console.error(
      `[ingest:history] wallet=${ownerPubkey} failed after ${durationMs}ms (runId=${runId}):`,
      message,
    );
    throw err;
  }
}
