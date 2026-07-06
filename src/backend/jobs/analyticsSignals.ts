/**
 * CLI tool: detect Smart Money Signals over a recent trade window and
 * print them as JSON. Run with:
 *   npm run analytics:signals
 *   npm run analytics:signals -- --lookbackMinutes=120 --minSmartScore=50 --consensusWallets=4 --whaleUsd=5000
 *
 * Read-only and offline from Jupiter's perspective — no Jupiter API
 * calls, no database writes (unlike `computeWalletScores.ts`, this phase
 * does not persist anything; see `docs/smart-money-signals.md` §5 for the
 * future persistence/alerts plan). Everything here is computed from
 * trades/scores earlier ingestion/`analytics:scores` runs already wrote
 * to Postgres.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gatherSignalDetectionInput } from '../analytics/signals/gatherSignalDetectionInput.js';
import {
  detectSmartMoneySignals,
  type DetectSmartMoneySignalsConfig,
} from '../analytics/signals/detectSmartMoneySignals.js';
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
      throw new Error(`analytics:signals: --${name} must be a positive number, got ${value}`);
    }
  }

  return { lookbackMinutes, minSmartScore, consensusWallets, whaleUsd };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined ? Number(raw) : undefined;
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

  const durationMs = Date.now() - startedAt;
  console.log(
    `[analytics:signals] lookbackMinutes=${config.lookbackMinutes} minSmartScore=${config.minSmartScore} ` +
      `consensusWallets=${config.consensusWallets} whaleUsd=${config.whaleUsd} ` +
      `trades=${input.trades.length} signals=${signals.length} durationMs=${durationMs}`,
  );
  console.log(JSON.stringify(signals, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error('[analytics:signals] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
