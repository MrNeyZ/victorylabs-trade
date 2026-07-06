/**
 * CLI entry point: ingest leaderboards once, then ingest profiles for the
 * top N wallets. Run with:
 *   npm run ingest:rankings
 *   npm run ingest:rankings -- --top=10
 *
 * Configurable via --top=<n> or RANKINGS_TOP_N env var (CLI takes
 * precedence). Bounded only — no forever mode, no daemon, no PM2 process:
 * one pass over the leaderboards plus the top N wallets, then exit.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ingestRankings, type IngestRankingsOptions } from '../ingestion/ingestRankings.js';
import { closePool } from '../db/client.js';

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function parseTopArg(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--top=')) {
      return Number(arg.slice('--top='.length));
    }
    if (arg === '--top') {
      return Number(argv[i + 1]);
    }
  }
  return undefined;
}

function resolveOptions(): IngestRankingsOptions {
  const cliTop = parseTopArg(process.argv.slice(2));
  const envTop = process.env['RANKINGS_TOP_N'];
  const top = cliTop ?? (envTop !== undefined ? Number(envTop) : undefined);

  const options: IngestRankingsOptions = {};
  if (top !== undefined) options.topN = top;
  return options;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  await ingestRankings(resolveOptions());
}

main()
  .catch((err: unknown) => {
    console.error('[ingest:rankings] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
