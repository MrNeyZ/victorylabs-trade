/**
 * VictoryLabs Trending Wallet Discovery — Phase 4.1. Pure scoring over
 * already-persisted data (`trades`, `wallet_score_snapshots`,
 * `smart_money_signals` — see `./gatherTrendingInput.ts` for how each is
 * fetched). No I/O of any kind, same pure/impure split as
 * `../scoring/computeWalletScore.ts`/`../signals/detectSmartMoneySignals.ts`.
 *
 * This is a deliberately different question from Smart Score
 * (`docs/smart-score.md`): Smart Score asks "is this wallet good,
 * historically" and is conservative on purpose (gated hard by sample
 * size and realized losses). Trending Score asks "is this wallet
 * becoming interesting RIGHT NOW" — a wallet can trend with a tiny
 * Smart Score (or none at all) if its activity just spiked; Smart Score
 * is only ONE of six inputs here, weighted lower than the two "is
 * something happening right now" signals (activity, growth). See
 * `docs/trending-wallets.md` for the full philosophy/formula writeup.
 *
 * Same "money as `Number` for scoring math only" exception this
 * project's other scoring modules already document
 * (`computeWalletScore.ts`'s module doc comment) — `recentVolumeUsd`/
 * `previousVolumeUsd` are converted to `Number` for log-scale/ratio math
 * here, never written back as a stored monetary amount.
 */
import type { WalletScoreSnapshotResult } from '../../db/repositories/walletScoresRepository.js';
import type { WalletActivityWindow } from '../../db/repositories/tradesRepository.js';
import type { WalletSignalCounts } from '../../db/repositories/signalsRepository.js';

export interface TrendingWalletInput {
  activity: WalletActivityWindow;
  /** `undefined` if this wallet has never been scored by `analytics:scores` — treated as "no Smart Score credit", not zero-and-penalized. */
  latestScore: WalletScoreSnapshotResult | undefined;
  /** `undefined` only if the wallet wasn't in the set passed to `getWalletSignalCounts` — in practice always present with `{0, 0}` for a wallet with no whale/consensus signals (see that function's own doc comment). */
  signalCounts: WalletSignalCounts | undefined;
}

export interface TrendingWallet {
  walletPubkey: string;
  /** 0-100. Not comparable to Smart Score's 0-100 scale — a different question, see module doc comment. */
  trendingScore: number;
  reason: string[];
  /** The wallet's Smart Score at the time of this computation, or `null` if it has never been scored. */
  latestSmartScore: number | null;
  recentTradeCount: number;
  recentVolumeUsd: string;
  lastActivityAt: Date;
}

export interface TrendingScoreConfig {
  /** Relative trade-count increase (recent vs. previous window) that earns full "growth" credit — e.g. `2` means a 200% increase (3x) maxes out the component. Default 2. */
  growthMultiplierForFullCredit?: number;
  /** Days since a wallet's first-ever trade before "novelty" credit fully decays to zero. Default 7. */
  noveltyWindowDays?: number;
}

const DEFAULT_GROWTH_MULTIPLIER_FOR_FULL_CREDIT = 2;
const DEFAULT_NOVELTY_WINDOW_DAYS = 7;
/** Cumulative recent-window USD volume at or above this (log-scaled) gets full "activity volume" credit — an order of magnitude below Smart Score's own `MEANINGFUL_VOLUME_USD` ($10,000), deliberately: trending is about a single recent window, not an all-time track record. */
const MEANINGFUL_RECENT_VOLUME_USD = 5_000;
/** Recent-window trade count at or above this gets full "activity trade count" credit. */
const MEANINGFUL_RECENT_TRADE_COUNT = 10;
const WHALE_SIGNALS_FOR_FULL_CREDIT = 2;
const CONSENSUS_SIGNALS_FOR_FULL_CREDIT = 1;

const WEIGHTS = {
  growth: 0.3,
  activity: 0.25,
  novelty: 0.15,
  smartScore: 0.1,
  whale: 0.1,
  consensus: 0.1,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function computeActivity01(activity: WalletActivityWindow): number {
  const volume = Number(activity.recentVolumeUsd);
  const volumeScore01 =
    volume > 0 ? clamp01(Math.log10(volume + 1) / Math.log10(MEANINGFUL_RECENT_VOLUME_USD + 1)) : 0;
  const countScore01 = clamp01(activity.recentTradeCount / MEANINGFUL_RECENT_TRADE_COUNT);
  return (volumeScore01 + countScore01) / 2;
}

/**
 * `0` if there's no recent activity at all (nothing to call "growing").
 * `1` (full credit) if there was recent activity but literally none in
 * the previous window — a brand-new burst has no baseline to compute a
 * ratio against, and "went from 0 to something" is exactly the kind of
 * pickup this component exists to catch. Otherwise, the relative
 * increase vs. the previous window, capped at `growthMultiplierForFullCredit`.
 */
function computeGrowth01(
  activity: WalletActivityWindow,
  growthMultiplierForFullCredit: number,
): number {
  if (activity.recentTradeCount === 0) return 0;
  if (activity.previousTradeCount === 0) return 1;
  const relativeIncrease =
    (activity.recentTradeCount - activity.previousTradeCount) / activity.previousTradeCount;
  return clamp01(relativeIncrease / growthMultiplierForFullCredit);
}

function daysSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
}

function computeNovelty01(
  activity: WalletActivityWindow,
  now: Date,
  noveltyWindowDays: number,
): number {
  return clamp01(1 - daysSince(activity.firstTradeAt, now) / noveltyWindowDays);
}

function computeSmartScore01(latestScore: WalletScoreSnapshotResult | undefined): number {
  return latestScore ? clamp01(latestScore.score / 100) : 0;
}

function computeWhale01(signalCounts: WalletSignalCounts | undefined): number {
  return signalCounts ? clamp01(signalCounts.whaleTradeCount / WHALE_SIGNALS_FOR_FULL_CREDIT) : 0;
}

function computeConsensus01(signalCounts: WalletSignalCounts | undefined): number {
  return signalCounts
    ? clamp01(signalCounts.marketConsensusCount / CONSENSUS_SIGNALS_FOR_FULL_CREDIT)
    : 0;
}

function buildReasons(
  activity: WalletActivityWindow,
  latestScore: WalletScoreSnapshotResult | undefined,
  signalCounts: WalletSignalCounts | undefined,
  now: Date,
): string[] {
  const reasons: string[] = [];

  reasons.push(
    `${activity.recentTradeCount} trade(s) totaling $${activity.recentVolumeUsd} in the lookback window.`,
  );

  if (activity.previousTradeCount === 0) {
    reasons.push('New burst of activity — no trades in the previous equivalent window.');
  } else if (activity.recentTradeCount > activity.previousTradeCount) {
    const pctIncrease = Math.round(
      ((activity.recentTradeCount - activity.previousTradeCount) / activity.previousTradeCount) *
        100,
    );
    reasons.push(
      `Trade count up ${pctIncrease}% vs. the previous window (${activity.previousTradeCount} → ${activity.recentTradeCount}).`,
    );
  }

  const firstTradeDaysAgo = Math.round(daysSince(activity.firstTradeAt, now));
  if (firstTradeDaysAgo <= DEFAULT_NOVELTY_WINDOW_DAYS) {
    reasons.push(
      firstTradeDaysAgo <= 0
        ? 'First trade seen today — a brand-new participant.'
        : `First trade seen ${firstTradeDaysAgo} day(s) ago — a recent addition.`,
    );
  }

  if (latestScore) {
    reasons.push(`Smart Score ${latestScore.score}/100 (${latestScore.tier}).`);
  }

  if (signalCounts && signalCounts.whaleTradeCount > 0) {
    reasons.push(`${signalCounts.whaleTradeCount} whale-trade signal(s) in this window.`);
  }

  if (signalCounts && signalCounts.marketConsensusCount > 0) {
    reasons.push(
      `Part of ${signalCounts.marketConsensusCount} market-consensus signal(s) in this window.`,
    );
  }

  return reasons;
}

export function computeTrendingScore(
  input: TrendingWalletInput,
  now: Date = new Date(),
  config: TrendingScoreConfig = {},
): TrendingWallet {
  const growthMultiplierForFullCredit =
    config.growthMultiplierForFullCredit ?? DEFAULT_GROWTH_MULTIPLIER_FOR_FULL_CREDIT;
  const noveltyWindowDays = config.noveltyWindowDays ?? DEFAULT_NOVELTY_WINDOW_DAYS;

  const { activity, latestScore, signalCounts } = input;

  const activity01 = computeActivity01(activity);
  const growth01 = computeGrowth01(activity, growthMultiplierForFullCredit);
  const novelty01 = computeNovelty01(activity, now, noveltyWindowDays);
  const smartScore01 = computeSmartScore01(latestScore);
  const whale01 = computeWhale01(signalCounts);
  const consensus01 = computeConsensus01(signalCounts);

  const blended01 =
    activity01 * WEIGHTS.activity +
    growth01 * WEIGHTS.growth +
    novelty01 * WEIGHTS.novelty +
    smartScore01 * WEIGHTS.smartScore +
    whale01 * WEIGHTS.whale +
    consensus01 * WEIGHTS.consensus;

  return {
    walletPubkey: activity.walletPubkey,
    trendingScore: Math.round(clamp01(blended01) * 100),
    reason: buildReasons(activity, latestScore, signalCounts, now),
    latestSmartScore: latestScore?.score ?? null,
    recentTradeCount: activity.recentTradeCount,
    recentVolumeUsd: activity.recentVolumeUsd,
    lastActivityAt: activity.lastTradeAt,
  };
}

/**
 * Scores every input and sorts descending by `trendingScore`, with two
 * deterministic tie-breakers (`recentVolumeUsd` desc, then `walletPubkey`
 * ascending) so equal-score wallets always land in the same relative
 * order run-to-run — `Array.prototype.sort` is stable per spec, but that
 * only helps if ties are broken explicitly; without these, two wallets
 * scoring identically would order however they happened to arrive from
 * the database, not by anything meaningful.
 */
export function rankTrendingWallets(
  inputs: TrendingWalletInput[],
  now: Date = new Date(),
  config: TrendingScoreConfig = {},
): TrendingWallet[] {
  const scored = inputs.map((input) => computeTrendingScore(input, now, config));

  scored.sort((a, b) => {
    if (b.trendingScore !== a.trendingScore) return b.trendingScore - a.trendingScore;
    const volumeDiff = Number(b.recentVolumeUsd) - Number(a.recentVolumeUsd);
    if (volumeDiff !== 0) return volumeDiff;
    return a.walletPubkey.localeCompare(b.walletPubkey);
  });

  return scored;
}
