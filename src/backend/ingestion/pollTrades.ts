/**
 * `/trades` polling loop — bounded by default (`maxIterations`), a true
 * daemon when `forever: true` (Phase 6.1, `vltrade-trades-poller` in
 * `ecosystem.config.cjs`). Every iteration reuses the one-shot ingestion
 * (`ingestTradesOnce.ts`) verbatim — same normalize/upsert/record-run
 * behavior per poll, just repeated on an interval — this is the only
 * place that calls it in a loop, and the only loop-scheduling logic in
 * this project; nothing duplicates either.
 *
 * Iterations never overlap: this is a plain sequential `await` loop, not
 * `setInterval` — the next iteration cannot start until the previous
 * one's DB write has fully finished, by construction.
 *
 * A single failed iteration (`ingestTradesOnce` already logs it and
 * records the failure to `ingestion_runs` before rethrowing) is caught
 * here and does NOT stop the loop — running "forever" would otherwise
 * mean one transient network/DB hiccup permanently kills continuous
 * ingestion until something manually restarts it. `shouldStop()` is
 * still always honored regardless of the current iteration's outcome
 * (the CLI entry point, `src/backend/jobs/pollTrades.ts`, wires that to
 * SIGINT/SIGTERM for graceful shutdown).
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import {
  ingestTradesOnce,
  clientOptionsFromEnv,
  type IngestTradesOnceResult,
} from './ingestTradesOnce.js';
import { getLatestObservedAt } from '../db/repositories/tradesRepository.js';

export const MIN_INTERVAL_SECONDS = 5;
export const DEFAULT_INTERVAL_SECONDS = 15;
export const DEFAULT_MAX_ITERATIONS = 5;

export interface PollTradesOptions {
  /** Seconds between the START of one poll and the next. Enforced minimum: 5s. Default: 15s. */
  intervalSeconds?: number;
  /** Ignored when `forever` is true. Default: 5. */
  maxIterations?: number;
  /** Loop until `shouldStop()` reports true instead of stopping after `maxIterations`. Default: false. */
  forever?: boolean;
  client?: JupiterPredictionClient;
  /** Checked before each iteration and while sleeping between iterations. Default: never stop early. */
  shouldStop?: () => boolean;
}

export interface PollTradesResult {
  iterationsRun: number;
  /** Iterations where `ingestTradesOnce` threw — already logged (and recorded to `ingestion_runs`) individually as they happened; not represented in `iterations` below. */
  iterationsFailed: number;
  stoppedEarly: boolean;
  iterations: IngestTradesOnceResult[];
}

async function sleepInterruptible(ms: number, shouldStop: () => boolean): Promise<void> {
  const stepMs = 200;
  let remaining = ms;
  while (remaining > 0 && !shouldStop()) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(stepMs, remaining)));
    remaining -= stepMs;
  }
}

export async function pollTrades(options: PollTradesOptions = {}): Promise<PollTradesResult> {
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const forever = options.forever ?? false;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const shouldStop = options.shouldStop ?? ((): boolean => false);

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new Error(
      `pollTrades: intervalSeconds must be a number >= ${MIN_INTERVAL_SECONDS}, got ${intervalSeconds}`,
    );
  }
  if (!forever && (!Number.isFinite(maxIterations) || maxIterations < 1)) {
    throw new Error(
      `pollTrades: maxIterations must be a positive integer (or pass forever: true), got ${maxIterations}`,
    );
  }

  const client = options.client ?? new JupiterPredictionClient(clientOptionsFromEnv());
  const iterations: IngestTradesOnceResult[] = [];
  let iteration = 0;
  let iterationsFailed = 0;
  let stoppedEarly = false;

  while (forever || iteration < maxIterations) {
    if (shouldStop()) {
      stoppedEarly = true;
      break;
    }

    iteration += 1;

    try {
      const result = await ingestTradesOnce(client);
      iterations.push(result);

      // Deliberately a separate DB read rather than reusing something off
      // `result` — an all-duplicates poll must report the *previous*
      // write's timestamp (unchanged), not "now", so a caller can see
      // ingestion has gone stale even while polls keep succeeding.
      const latestObservedAt = await getLatestObservedAt();
      console.log(
        `[trade-poller] fetched=${result.fetched} new=${result.upserted} ` +
          `duplicates=${result.duplicates} duration=${result.durationMs}ms ` +
          `latestObservedAt=${latestObservedAt ? latestObservedAt.toISOString() : 'null'}`,
      );
    } catch (err) {
      // `ingestTradesOnce` already logged the error and recorded it to
      // `ingestion_runs` before rethrowing — this is deliberately terse
      // (one line, not a second stack trace) to avoid doubling up on
      // noise, and deliberately does NOT rethrow: one bad iteration must
      // not end continuous ingestion.
      iterationsFailed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[trade-poller] iteration failed, continuing: ${message}`);
    }

    const isLastPlannedIteration = !forever && iteration >= maxIterations;
    if (shouldStop()) {
      stoppedEarly = true;
      break;
    }
    if (isLastPlannedIteration) {
      break;
    }

    await sleepInterruptible(intervalSeconds * 1000, shouldStop);
  }

  console.log(
    `[poll:trades] done — ${iterations.length} iteration(s) run` +
      (iterationsFailed > 0 ? `, ${iterationsFailed} failed` : '') +
      (stoppedEarly ? ' (stopped early)' : ''),
  );

  return { iterationsRun: iterations.length, iterationsFailed, stoppedEarly, iterations };
}
