/**
 * CLI entry point: bounded wallet-history ingestion for the N most
 * recently active wallets. Run with:
 *   npm run ingest:history:recent
 *   npm run ingest:history:recent -- --limit=3 --since-minutes=120
 *
 * Configurable via CLI flags (checked first) or env vars (fallback):
 *   --limit=<n>              HISTORY_RECENT_WALLET_LIMIT     default 5
 *   --since-minutes=<n>      HISTORY_RECENT_SINCE_MINUTES    default 60
 *
 * Bounded only — no forever mode, no daemon, no PM2 process: one pass
 * over a fixed list of candidate wallets, then exit.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ingestRecentWalletHistory,
  type IngestRecentWalletHistoryOptions,
} from '../ingestion/ingestRecentWalletHistory.js';
import { closePool } from '../db/client.js';

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

interface CliArgs {
  limit?: number;
  sinceMinutes?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--limit') {
      i += 1;
      args.limit = Number(argv[i]);
    } else if (arg?.startsWith('--since-minutes=')) {
      args.sinceMinutes = Number(arg.slice('--since-minutes='.length));
    } else if (arg === '--since-minutes') {
      i += 1;
      args.sinceMinutes = Number(argv[i]);
    }
  }
  return args;
}

function resolveOptions(): IngestRecentWalletHistoryOptions {
  const cli = parseArgs(process.argv.slice(2));

  const envLimit = process.env['HISTORY_RECENT_WALLET_LIMIT'];
  const envSinceMinutes = process.env['HISTORY_RECENT_SINCE_MINUTES'];

  const limit = cli.limit ?? (envLimit !== undefined ? Number(envLimit) : undefined);
  const sinceMinutes =
    cli.sinceMinutes ?? (envSinceMinutes !== undefined ? Number(envSinceMinutes) : undefined);

  const options: IngestRecentWalletHistoryOptions = {};
  if (limit !== undefined) options.limit = limit;
  if (sinceMinutes !== undefined) options.sinceMinutes = sinceMinutes;
  return options;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  await ingestRecentWalletHistory(resolveOptions());
}

main()
  .catch((err: unknown) => {
    console.error('[ingest:history:recent] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
