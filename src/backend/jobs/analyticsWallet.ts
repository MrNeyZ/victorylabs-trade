/**
 * CLI tool: compute and print wallet statistics from our own database.
 * Run with:
 *   npm run analytics:wallet -- <wallet_pubkey>
 *
 * Read-only and offline from Jupiter's perspective: gathers whatever
 * trades/history/positions/profile this project has already ingested for
 * one wallet and runs them through the pure `computeWalletStats`. Never
 * calls the Jupiter API, never writes to the database.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gatherWalletStatsInput } from '../analytics/walletStats/gatherWalletStatsInput.js';
import { computeWalletStats } from '../analytics/walletStats/computeWalletStats.js';
import { closePool } from '../db/client.js';

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnvIfPresent();

  const walletPubkey = process.argv[2];
  if (!walletPubkey) {
    console.error('Usage: npm run analytics:wallet -- <wallet_pubkey>');
    process.exitCode = 1;
    return;
  }

  const input = await gatherWalletStatsInput(walletPubkey);
  const stats = computeWalletStats(input);

  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error('[analytics:wallet] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
