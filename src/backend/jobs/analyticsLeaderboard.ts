/**
 * CLI tool: gather candidate wallets, compute WalletStats + Smart Score
 * for each, print the top N sorted by score descending. Run with:
 *   npm run analytics:leaderboard
 *   npm run analytics:leaderboard -- --top=20
 *
 * Configurable via --top=<n> or LEADERBOARD_TOP_N env var (CLI takes
 * precedence), default 50. Read-only and offline from Jupiter's
 * perspective: no database writes, no Jupiter API calls — everything
 * here is computed from what earlier ingestion jobs already wrote to
 * Postgres. Candidate wallets are processed sequentially (not
 * Promise.all-ed), deliberately — the candidate pool can run into the
 * hundreds, and this project's `pg` Pool isn't sized for that many
 * concurrent queries at once; this is a bounded, one-shot CLI, not a hot
 * path, so trading some wall-clock time for not exhausting the pool is
 * the right call.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gatherCandidateWallets } from '../analytics/scoring/gatherCandidateWallets.js';
import { gatherWalletStatsInput } from '../analytics/walletStats/gatherWalletStatsInput.js';
import { computeWalletStats } from '../analytics/walletStats/computeWalletStats.js';
import { computeWalletScore, type WalletScore } from '../analytics/scoring/computeWalletScore.js';
import { closePool } from '../db/client.js';

const DEFAULT_TOP_N = 50;

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

function resolveTopN(): number {
  const cliTop = parseTopArg(process.argv.slice(2));
  const envTop = process.env['LEADERBOARD_TOP_N'];
  const top = cliTop ?? (envTop !== undefined ? Number(envTop) : undefined) ?? DEFAULT_TOP_N;
  if (!Number.isFinite(top) || top < 1) {
    throw new Error(`analytics:leaderboard: --top must be a positive integer, got ${top}`);
  }
  return top;
}

function shortenPubkey(pubkey: string): string {
  return pubkey.length > 10 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

async function main(): Promise<void> {
  loadEnvIfPresent();
  const topN = resolveTopN();

  const candidateWallets = await gatherCandidateWallets();
  console.log(`[analytics:leaderboard] ${candidateWallets.length} candidate wallet(s) gathered`);

  const scores: WalletScore[] = [];
  for (const walletPubkey of candidateWallets) {
    const input = await gatherWalletStatsInput(walletPubkey);
    const stats = computeWalletStats(input);
    scores.push(computeWalletScore(stats));
  }

  // Stable sort by score descending — Array.prototype.sort has been a
  // stable sort per spec since ES2019, so equal-score wallets keep their
  // relative gathering order run-to-run rather than shuffling.
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, topN);

  console.log(
    `\n[analytics:leaderboard] top ${top.length} of ${scores.length} scored wallet(s):\n`,
  );
  console.table(
    top.map((entry, index) => ({
      rank: index + 1,
      wallet: shortenPubkey(entry.walletPubkey),
      score: entry.score,
      tier: entry.tier,
      profitability: entry.components.profitability,
      consistency: entry.components.consistency,
      activity: entry.components.activity,
      recency: entry.components.recency,
      sampleSize: entry.components.sampleSize,
    })),
  );

  console.log('\n[analytics:leaderboard] full JSON:\n');
  console.log(JSON.stringify(top, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error('[analytics:leaderboard] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
