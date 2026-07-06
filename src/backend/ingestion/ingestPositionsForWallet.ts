/**
 * One-shot ingestion: fetch `/positions` for a single wallet once,
 * normalize, upsert, record the run. Mirrors `ingestHistoryForWallet.ts`'s
 * structure — except the upsert here is a true update (see
 * `positionsRepository.ts`), not an immutable-fact `DO NOTHING`.
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { normalizePosition } from '../core/normalizePosition.js';
import { upsertPositions, countPositions } from '../db/repositories/positionsRepository.js';
import {
  startIngestionRun,
  finishIngestionRun,
} from '../db/repositories/ingestionRunsRepository.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

const ENDPOINT_NAME = 'positions';

export interface IngestPositionsForWalletResult {
  runId: number;
  ownerPubkey: string;
  fetched: number;
  upserted: number;
  totalPositionsInDb: number;
  durationMs: number;
}

export async function ingestPositionsForWallet(
  ownerPubkey: string,
  client: JupiterPredictionClient = new JupiterPredictionClient(clientOptionsFromEnv()),
): Promise<IngestPositionsForWalletResult> {
  const startedAt = Date.now();
  const runId = await startIngestionRun(ENDPOINT_NAME, { ownerPubkey });

  try {
    const rawPositions = await client.getPositions({ ownerPubkey });
    const observedAt = new Date();
    const inputs = rawPositions.map((raw) => ({
      position: normalizePosition(raw, observedAt),
      raw,
    }));

    const upserted = await upsertPositions(inputs);
    const totalPositionsInDb = await countPositions();
    const durationMs = Date.now() - startedAt;

    await finishIngestionRun(runId, {
      status: 'success',
      rowsFetched: rawPositions.length,
      rowsUpserted: upserted,
      errorMessage: null,
    });

    console.log(
      `[ingest:positions] wallet=${ownerPubkey} fetched=${rawPositions.length} upserted=${upserted} ` +
        `totalInDb=${totalPositionsInDb} durationMs=${durationMs} runId=${runId}`,
    );

    return {
      runId,
      ownerPubkey,
      fetched: rawPositions.length,
      upserted,
      totalPositionsInDb,
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
      console.error('[ingest:positions] also failed to record run failure', finishErr);
    });

    console.error(
      `[ingest:positions] wallet=${ownerPubkey} failed after ${durationMs}ms (runId=${runId}):`,
      message,
    );
    throw err;
  }
}
