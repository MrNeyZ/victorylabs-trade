/**
 * CLI entry point: bounded `/trades` polling. Run with:
 *   npm run ingest:trades:poll
 *   npm run ingest:trades:poll -- --interval=10 --max-iterations=3
 *   npm run ingest:trades:poll -- --forever   (NOT used in verification —
 *     stops only on SIGINT/SIGTERM; every other invocation is bounded)
 *
 * Configurable via CLI flags (checked first) or env vars (fallback):
 *   --interval=<seconds>        POLL_TRADES_INTERVAL_SECONDS   default 15, min 5
 *   --max-iterations=<n>        POLL_TRADES_MAX_ITERATIONS     default 5
 *   --forever                   POLL_TRADES_FOREVER=1|true     default false
 *
 * SIGINT/SIGTERM stop the loop cleanly after the in-flight iteration
 * finishes (never mid-DB-write) rather than killing the process outright.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pollTrades, type PollTradesOptions } from '../ingestion/pollTrades.js';
import { closePool } from '../db/client.js';

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

interface CliArgs {
  interval?: number;
  maxIterations?: number;
  forever?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--forever') {
      args.forever = true;
    } else if (arg?.startsWith('--interval=')) {
      args.interval = Number(arg.slice('--interval='.length));
    } else if (arg === '--interval') {
      i += 1;
      args.interval = Number(argv[i]);
    } else if (arg?.startsWith('--max-iterations=')) {
      args.maxIterations = Number(arg.slice('--max-iterations='.length));
    } else if (arg === '--max-iterations') {
      i += 1;
      args.maxIterations = Number(argv[i]);
    }
  }
  return args;
}

function resolveOptions(): PollTradesOptions {
  const cli = parseArgs(process.argv.slice(2));

  const envInterval = process.env['POLL_TRADES_INTERVAL_SECONDS'];
  const envMaxIterations = process.env['POLL_TRADES_MAX_ITERATIONS'];
  const envForever = process.env['POLL_TRADES_FOREVER'];

  const interval = cli.interval ?? (envInterval !== undefined ? Number(envInterval) : undefined);
  const maxIterations =
    cli.maxIterations ?? (envMaxIterations !== undefined ? Number(envMaxIterations) : undefined);
  const forever = cli.forever ?? (envForever === '1' || envForever === 'true');

  const options: PollTradesOptions = {};
  if (interval !== undefined) options.intervalSeconds = interval;
  if (maxIterations !== undefined) options.maxIterations = maxIterations;
  if (forever) options.forever = forever;
  return options;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  const options = resolveOptions();

  let stopRequested = false;
  const requestStop = (signal: string): void => {
    if (stopRequested) return;
    stopRequested = true;
    console.log(`[poll:trades] received ${signal} — stopping after the current iteration`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  options.shouldStop = (): boolean => stopRequested;

  await pollTrades(options);
}

main()
  .catch((err: unknown) => {
    console.error('[ingest:trades:poll] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
