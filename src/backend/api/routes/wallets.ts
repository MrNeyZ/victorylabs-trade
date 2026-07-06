/**
 * GET /api/wallets/:walletPubkey — combined read-only view of everything
 * ingested so far for one wallet: profile snapshot (if any), latest
 * positions, recent trades, recent history events, and the latest
 * persisted Smart Score snapshot (if any — Phase 3.3, see
 * `../../db/repositories/walletScoresRepository.ts`). A syntactically
 * valid pubkey we simply have no data for is not an error — it returns
 * 200 with `profile: null`/`latestSmartScore: null` and empty arrays, not
 * a 404 (this is a query over an open identifier space, not a lookup of a
 * resource that must exist).
 */
import { Router } from 'express';
import { getWalletProfile } from '../../db/repositories/walletProfilesRepository.js';
import { getPositionsForWallet } from '../../db/repositories/positionsRepository.js';
import { getRecentTrades } from '../../db/repositories/tradesRepository.js';
import { getRecentHistoryForWallet } from '../../db/repositories/historyRepository.js';
import { getWalletScoreHistory } from '../../db/repositories/walletScoresRepository.js';

export const walletsRouter = Router();

const RECENT_TRADES_LIMIT = 50;
const RECENT_HISTORY_LIMIT = 50;

walletsRouter.get('/:walletPubkey', async (req, res) => {
  const { walletPubkey } = req.params;
  if (!walletPubkey) {
    res.status(400).json({ error: 'invalid_wallet_pubkey' });
    return;
  }

  const [profile, positions, recentTrades, recentHistory, scoreHistory] = await Promise.all([
    getWalletProfile(walletPubkey),
    getPositionsForWallet(walletPubkey),
    getRecentTrades({ ownerPubkey: walletPubkey, limit: RECENT_TRADES_LIMIT }),
    getRecentHistoryForWallet(walletPubkey, RECENT_HISTORY_LIMIT),
    getWalletScoreHistory(walletPubkey),
  ]);

  res.json({
    walletPubkey,
    profile,
    positions,
    recentTrades,
    recentHistory,
    latestSmartScore: scoreHistory[0] ?? null,
  });
});
