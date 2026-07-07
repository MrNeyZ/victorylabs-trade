/**
 * Global search — Phase 5.1. Pure ranking over already-fetched candidates
 * (`../../db/repositories/searchRepository.ts`) plus each wallet's latest
 * Smart Score snapshot. No I/O, same pure/impure split as every other
 * analytics module in this project.
 *
 * Unlike Trending Wallet/Market Score, there's no blended numeric score
 * here — this is literal identifier/text search, not a heuristic. The
 * only "scoring" concept is the sort order the requirement specifies
 * directly: wallets by recent activity then Smart Score; markets by
 * recent activity alone.
 */
import type {
  WalletSearchCandidate,
  MarketSearchCandidate,
} from '../../db/repositories/searchRepository.js';
import type { WalletScoreSnapshotResult } from '../../db/repositories/walletScoresRepository.js';
import type { WalletScoreTier } from '../scoring/computeWalletScore.js';

export interface WalletSearchResult {
  walletPubkey: string;
  latestSmartScore: number | null;
  latestTier: WalletScoreTier | null;
  recentTradeCount: number;
  lastActivityAt: Date;
}

export interface MarketSearchResult {
  marketId: string;
  eventTitle: string | null;
  recentTradeCount: number;
  lastActivityAt: Date;
}

/**
 * `lastActivityAt` descending is the dominant sort key (already applied
 * by the repository's own `ORDER BY`, but re-sorted here since only this
 * function knows each wallet's Smart Score, needed for the tie-break);
 * `latestSmartScore` descending (unscored wallets treated as lower than
 * any real score, not as `0`) is the tie-break, and `walletPubkey`
 * ascending is the final one, for fully deterministic output — same
 * "always have an explicit final tie-breaker" discipline
 * `rankTrendingWallets`/`rankTrendingMarkets` (Phase 4.1/4.2) established.
 */
export function rankWalletSearchResults(
  candidates: WalletSearchCandidate[],
  scoresByWallet: Map<string, WalletScoreSnapshotResult>,
  limit: number,
): WalletSearchResult[] {
  const results: WalletSearchResult[] = candidates.map((candidate) => {
    const score = scoresByWallet.get(candidate.walletPubkey);
    return {
      walletPubkey: candidate.walletPubkey,
      latestSmartScore: score?.score ?? null,
      latestTier: score?.tier ?? null,
      recentTradeCount: candidate.tradeCount,
      lastActivityAt: candidate.lastActivityAt,
    };
  });

  results.sort((a, b) => {
    const activityDiff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    if (activityDiff !== 0) return activityDiff;
    const scoreDiff = (b.latestSmartScore ?? -1) - (a.latestSmartScore ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    return a.walletPubkey.localeCompare(b.walletPubkey);
  });

  return results.slice(0, limit);
}

/** `lastActivityAt` descending, `marketId` ascending as the final tie-breaker — no secondary ranking criterion was specified for markets, unlike wallets. */
export function rankMarketSearchResults(
  candidates: MarketSearchCandidate[],
  limit: number,
): MarketSearchResult[] {
  const results: MarketSearchResult[] = candidates.map((candidate) => ({
    marketId: candidate.marketId,
    eventTitle: candidate.eventTitle,
    recentTradeCount: candidate.tradeCount,
    lastActivityAt: candidate.lastActivityAt,
  }));

  results.sort((a, b) => {
    const activityDiff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    if (activityDiff !== 0) return activityDiff;
    return a.marketId.localeCompare(b.marketId);
  });

  return results.slice(0, limit);
}
