/**
 * Data-access layer for the `ingestion_runs` bookkeeping table. Not named in
 * Phase 2.2's file list explicitly, but required by it: "create
 * ingestion_runs row at start" / "update ingestion_runs with success/failure
 * stats" belongs here, not inline in the ingestion service, for the same
 * reason `tradesRepository.ts` is separate from `ingestTradesOnce.ts`.
 */
import { getPool } from '../client.js';
import type { IngestionRunStatus } from '../../types/domain.js';

export async function startIngestionRun(endpoint: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ingestion_runs (endpoint, started_at, status)
     VALUES ($1, now(), 'running')
     RETURNING id`,
    [endpoint],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error('startIngestionRun: insert did not return an id');
  }
  return id;
}

export interface FinishIngestionRunInput {
  status: IngestionRunStatus;
  rowsFetched: number | null;
  rowsUpserted: number | null;
  errorMessage: string | null;
}

export async function finishIngestionRun(
  id: number,
  input: FinishIngestionRunInput,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ingestion_runs
     SET finished_at = now(), status = $2, rows_fetched = $3, rows_upserted = $4, error_message = $5
     WHERE id = $1`,
    [id, input.status, input.rowsFetched, input.rowsUpserted, input.errorMessage],
  );
}
