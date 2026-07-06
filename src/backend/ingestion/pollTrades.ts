/**
 * Bounded `/trades` polling loop. Each iteration reuses the one-shot
 * ingestion (`ingestTradesOnce.ts`) verbatim — same normalize/upsert/
 * record-run behavior per poll, just repeated on an interval. This is
 * still NOT a daemon: it stops after `maxIterations` polls unless
 * `forever` is explicitly set, and always stops early if `shouldStop()`
 * reports true (the CLI entry point, `src/backend/jobs/pollTrades.ts`,
 * wires that to SIGINT/SIGTERM).
 */
import { JupiterPredictionClient } from '../services/jupiterPredictionClient.js';
import {
  ingestTradesOnce,
  clientOptionsFromEnv,
  type IngestTradesOnceResult,
} from './ingestTradesOnce.js';

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
  let stoppedEarly = false;

  while (forever || iteration < maxIterations) {
    if (shouldStop()) {
      stoppedEarly = true;
      break;
    }

    iteration += 1;
    const label = forever ? `${iteration}` : `${iteration}/${maxIterations}`;
    console.log(`[poll:trades] iteration ${label} starting`);

    const result = await ingestTradesOnce(client);
    iterations.push(result);

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
      (stoppedEarly ? ' (stopped early)' : ''),
  );

  return { iterationsRun: iterations.length, stoppedEarly, iterations };
}
