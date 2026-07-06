/**
 * One-shot ingestion: fetch `/profiles/{ownerPubkey}` once, normalize,
 * upsert into `wallet_profiles`, record the run. Mirrors
 * `ingestTradesOnce.ts`'s structure, parametrized by wallet — except the
 * upsert here is a true update (see `walletProfilesRepository.ts`), not
 * an immutable-fact `DO NOTHING`.
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import { normalizeWalletProfile } from '../core/normalizeWalletProfile.js';
import { upsertWalletProfile } from '../db/repositories/walletProfilesRepository.js';
import {
  startIngestionRun,
  finishIngestionRun,
} from '../db/repositories/ingestionRunsRepository.js';
import { clientOptionsFromEnv } from './ingestTradesOnce.js';

const ENDPOINT_NAME = 'profiles';

export interface IngestWalletProfileResult {
  runId: number;
  ownerPubkey: string;
  durationMs: number;
}

export async function ingestWalletProfile(
  ownerPubkey: string,
  client: JupiterPredictionClient = new JupiterPredictionClient(clientOptionsFromEnv()),
): Promise<IngestWalletProfileResult> {
  const startedAt = Date.now();
  const runId = await startIngestionRun(ENDPOINT_NAME, { ownerPubkey });

  try {
    const raw = await client.getProfile(ownerPubkey);
    const snapshotAt = new Date();
    const profile = normalizeWalletProfile(raw, snapshotAt);
    await upsertWalletProfile({ profile, raw });

    const durationMs = Date.now() - startedAt;
    await finishIngestionRun(runId, {
      status: 'success',
      rowsFetched: 1,
      rowsUpserted: 1,
      errorMessage: null,
    });

    console.log(`[ingest:profile] wallet=${ownerPubkey} durationMs=${durationMs} runId=${runId}`);

    return { runId, ownerPubkey, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    await finishIngestionRun(runId, {
      status: 'error',
      rowsFetched: null,
      rowsUpserted: null,
      errorMessage: message,
    }).catch((finishErr: unknown) => {
      console.error('[ingest:profile] also failed to record run failure', finishErr);
    });

    console.error(
      `[ingest:profile] wallet=${ownerPubkey} failed after ${durationMs}ms (runId=${runId}):`,
      message,
    );
    throw err;
  }
}
