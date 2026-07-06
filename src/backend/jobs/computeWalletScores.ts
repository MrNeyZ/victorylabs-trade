/**
 * CLI entry point (Phase 3.3): gather candidate wallets, compute
 * `WalletStats` + Smart Score for each, persist one snapshot row per
 * wallet into `wallet_score_snapshots`. Run with:
 *   npm run analytics:scores
 *   npm run analytics:scores -- --max=100
 *
 * Read-only from Jupiter's perspective, same as `analyticsLeaderboard.ts`:
 * no Jupiter API calls, only reads what earlier ingestion jobs already
 * wrote to Postgres — this job's only write is the derived
 * `wallet_score_snapshots` table. Bounded, one-shot: no loop, no daemon,
 * no PM2.
 *
 * Idempotency: `snapshotAt` is floored to a 5-minute bucket
 * (`SNAPSHOT_BUCKET_MS`, same mechanism as `ingestLeaderboards.ts`)
 * before any row is built, and `insertWalletScoreSnapshots` is
 * `ON CONFLICT (wallet_pubkey, snapshot_at) DO NOTHING` — re-running this
 * job within the same 5-minute window inserts 0 new rows.
 *
 * Candidate wallets are scored sequentially (not `Promise.all`-ed),
 * deliberately — same reasoning as `analyticsLeaderboard.ts`: the
 * candidate pool can run into the hundreds and this project's `pg` Pool
 * isn't sized for that many concurrent queries at once.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gatherCandidateWallets } from '../analytics/scoring/gatherCandidateWallets.js';
import { gatherWalletStatsInput } from '../analytics/walletStats/gatherWalletStatsInput.js';
import { computeWalletStats } from '../analytics/walletStats/computeWalletStats.js';
import { computeWalletScore } from '../analytics/scoring/computeWalletScore.js';
import {
  insertWalletScoreSnapshots,
  type WalletScoreSnapshotInsertInput,
} from '../db/repositories/walletScoresRepository.js';
import { floorToBucket } from '../utils/time.js';
import { closePool } from '../db/client.js';

const DEFAULT_MAX_WALLETS = 500;
export const SNAPSHOT_BUCKET_MS = 5 * 60 * 1000;

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function parseMaxArg(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--max=')) {
      return Number(arg.slice('--max='.length));
    }
    if (arg === '--max') {
      return Number(argv[i + 1]);
    }
  }
  return undefined;
}

function resolveMaxWallets(): number {
  const cliMax = parseMaxArg(process.argv.slice(2));
  const envMax = process.env['ANALYTICS_SCORES_MAX_WALLETS'];
  const max = cliMax ?? (envMax !== undefined ? Number(envMax) : undefined) ?? DEFAULT_MAX_WALLETS;
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`analytics:scores: --max must be a positive integer, got ${max}`);
  }
  return max;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  const maxWallets = resolveMaxWallets();
  const startedAt = Date.now();

  const candidateWallets = (await gatherCandidateWallets()).slice(0, maxWallets);
  console.log(
    `[analytics:scores] ${candidateWallets.length} candidate wallet(s) gathered (max=${maxWallets})`,
  );

  // Bucketed once, up front, so every wallet scored in this run shares
  // the exact same snapshotAt — that's what makes them one comparable
  // "snapshot bucket" for GET /api/scores/latest.
  const snapshotAt = floorToBucket(new Date(), SNAPSHOT_BUCKET_MS);

  const inputs: WalletScoreSnapshotInsertInput[] = [];
  for (const walletPubkey of candidateWallets) {
    const statsInput = await gatherWalletStatsInput(walletPubkey);
    const stats = computeWalletStats(statsInput);
    const walletScore = computeWalletScore(stats);
    inputs.push({ walletScore, stats, snapshotAt });
  }

  const inserted = await insertWalletScoreSnapshots(inputs);
  const duplicates = inputs.length - inserted;
  const durationMs = Date.now() - startedAt;

  console.log(
    `[analytics:scores] snapshotAt=${snapshotAt.toISOString()} scored=${inputs.length} ` +
      `inserted=${inserted} duplicates=${duplicates} durationMs=${durationMs}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('[analytics:scores] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
