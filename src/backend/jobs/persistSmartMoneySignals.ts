/**
 * CLI tool: run Smart Money Signal detection once and persist whatever it
 * finds. Run with:
 *   npm run analytics:signals:persist
 *   npm run analytics:signals:persist -- --lookbackMinutes=120 --minSmartScore=50 --consensusWallets=4 --whaleUsd=5000
 *
 * Same configuration surface as `analytics:signals.ts` (Phase 3.5) — this
 * job just adds one write step at the end
 * (`signalsRepository.upsertSignals`). Read-only from Jupiter's
 * perspective (no Jupiter API calls); bounded, one-shot: no loop, no
 * daemon, no PM2.
 *
 * Idempotency: every `Signal.id` is a deterministic, content-derived
 * string (see `detectSmartMoneySignals.ts`'s `signalId()`), and
 * `upsertSignals` is `ON CONFLICT (id) DO NOTHING` — re-running this job
 * over an overlapping lookback window re-detects the same signals but
 * inserts 0 new rows for any of them, exactly like
 * `computeWalletScores.ts`'s 5-minute-bucket idempotency (a different
 * mechanism reaching the same outcome: there, the bucketed `snapshotAt`
 * makes repeat runs collide; here, the signal's own content does).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gatherSignalDetectionInput } from '../analytics/signals/gatherSignalDetectionInput.js';
import {
  detectSmartMoneySignals,
  type DetectSmartMoneySignalsConfig,
} from '../analytics/signals/detectSmartMoneySignals.js';
import { upsertSignals } from '../db/repositories/signalsRepository.js';
import { closePool } from '../db/client.js';

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_MIN_SMART_SCORE = 35;
const DEFAULT_CONSENSUS_WALLETS = 3;
const DEFAULT_WHALE_USD = 1000;

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function parseNumberArg(argv: string[], name: string): number | undefined {
  const flagWithEquals = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith(flagWithEquals)) {
      return Number(arg.slice(flagWithEquals.length));
    }
    if (arg === `--${name}`) {
      return Number(argv[i + 1]);
    }
  }
  return undefined;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined ? Number(raw) : undefined;
}

interface ResolvedConfig {
  lookbackMinutes: number;
  minSmartScore: number;
  consensusWallets: number;
  whaleUsd: number;
}

function resolveConfig(): ResolvedConfig {
  const argv = process.argv.slice(2);

  const lookbackMinutes =
    parseNumberArg(argv, 'lookbackMinutes') ??
    envNumber('ANALYTICS_SIGNALS_LOOKBACK_MINUTES') ??
    DEFAULT_LOOKBACK_MINUTES;
  const minSmartScore =
    parseNumberArg(argv, 'minSmartScore') ??
    envNumber('ANALYTICS_SIGNALS_MIN_SMART_SCORE') ??
    DEFAULT_MIN_SMART_SCORE;
  const consensusWallets =
    parseNumberArg(argv, 'consensusWallets') ??
    envNumber('ANALYTICS_SIGNALS_CONSENSUS_WALLETS') ??
    DEFAULT_CONSENSUS_WALLETS;
  const whaleUsd =
    parseNumberArg(argv, 'whaleUsd') ??
    envNumber('ANALYTICS_SIGNALS_WHALE_USD') ??
    DEFAULT_WHALE_USD;

  for (const [name, value] of Object.entries({
    lookbackMinutes,
    minSmartScore,
    consensusWallets,
    whaleUsd,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `analytics:signals:persist: --${name} must be a positive number, got ${value}`,
      );
    }
  }

  return { lookbackMinutes, minSmartScore, consensusWallets, whaleUsd };
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  const config = resolveConfig();
  const startedAt = Date.now();

  const input = await gatherSignalDetectionInput(config.lookbackMinutes);

  const detectorConfig: DetectSmartMoneySignalsConfig = {
    minSmartScore: config.minSmartScore,
    consensusWallets: config.consensusWallets,
    whaleUsd: config.whaleUsd,
  };
  const signals = detectSmartMoneySignals(input, detectorConfig);

  const inserted = await upsertSignals(signals);
  const duplicates = signals.length - inserted;
  const durationMs = Date.now() - startedAt;

  console.log(
    `[analytics:signals:persist] lookbackMinutes=${config.lookbackMinutes} minSmartScore=${config.minSmartScore} ` +
      `consensusWallets=${config.consensusWallets} whaleUsd=${config.whaleUsd}`,
  );
  console.log(
    `[analytics:signals:persist] fetched=${input.trades.length} detected=${signals.length} ` +
      `inserted=${inserted} duplicates=${duplicates} durationMs=${durationMs}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('[analytics:signals:persist] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
