/**
 * The impure half of wallet-stats: fetches everything
 * `computeWalletStats.ts` needs for one wallet from Postgres, in
 * parallel, and hands it over as a plain object. All the actual
 * arithmetic happens in the pure function — this file is I/O only.
 */
import { getAllTradesForWallet } from '../../db/repositories/tradesRepository.js';
import { getAllHistoryForWallet } from '../../db/repositories/historyRepository.js';
import { getPositionsForWallet } from '../../db/repositories/positionsRepository.js';
import { getWalletProfile } from '../../db/repositories/walletProfilesRepository.js';
import type { ComputeWalletStatsInput } from './computeWalletStats.js';

export async function gatherWalletStatsInput(
  walletPubkey: string,
): Promise<ComputeWalletStatsInput> {
  const [trades, historyEvents, positions, walletProfile] = await Promise.all([
    getAllTradesForWallet(walletPubkey),
    getAllHistoryForWallet(walletPubkey),
    getPositionsForWallet(walletPubkey),
    getWalletProfile(walletPubkey),
  ]);

  return { walletPubkey, trades, historyEvents, positions, walletProfile };
}
