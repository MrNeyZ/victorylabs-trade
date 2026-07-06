/**
 * CLI entry point: run the one-shot trades ingestion and exit.
 * Run with: npm run ingest:trades:once
 *
 * Not a daemon — no loop, no scheduler. `JUPITER_API_KEY` is optional
 * (reads work keyless at low volume, see
 * docs/jupiter-prediction-discovery.md §7.1); `DATABASE_URL` is required
 * and failure to set it fails loudly (see `src/backend/db/client.ts`).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ingestTradesOnce } from '../ingestion/ingestTradesOnce.js';
import { closePool } from '../db/client.js';

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  await ingestTradesOnce();
}

main()
  .catch((err: unknown) => {
    console.error('[ingest:trades:once] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
