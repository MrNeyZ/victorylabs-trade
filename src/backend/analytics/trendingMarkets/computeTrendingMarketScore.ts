/**
 * VictoryLabs Trending Market Discovery — Phase 4.2. Pure scoring over
 * already-persisted data (`trades`, `wallet_score_snapshots`,
 * `smart_money_signals` — see `./gatherTrendingMarketsInput.ts` for how
 * each is fetched). No I/O of any kind, same pure/impure split as every
 * other analytics module in this project.
 *
 * The market-scoped sibling of Trending Wallet Score
 * (`../trending/computeTrendingScore.ts`, Phase 4.1) — same underlying
 * question ("is this interesting RIGHT NOW", not "is this the best"),
 * applied to a market instead of a wallet. Deliberately a separate module
 * with its own constants/weights, not a generalization of the wallet
 * version — this phase's brief was explicit that neither Smart Score nor
 * Trending Wallet Score should change.
 *
 * Two signals here have no wallet-side equivalent: `participation`
 * (distinct trader count — a market many *different* wallets are
 * touching is a stronger signal than one wallet trading itself in
 * circles) and `smartParticipation` (how many of those traders are
 * themselves smart-scored wallets). Conversely, this module has no
 * "novelty" component — "when did this market first appear" isn't a
 * signal this phase's brief asked for, and markets don't have the same
 * "brand-new participant" framing a wallet does.
 *
 * Same "money as `Number` for scoring math only" exception this
 * project's other scoring modules document — `recentVolumeUsd`/
 * `previousVolumeUsd` are converted to `Number` for log-scale/ratio math
 * here, never written back as a stored monetary amount.
 */
import type { MarketActivityWindow } from '../../db/repositories/tradesRepository.js';
import type { MarketSignalCounts } from '../../db/repositories/signalsRepository.js';

export interface TrendingMarketInput {
  activity: MarketActivityWindow;
  /** How many of this market's recent traders (`activity.uniqueWallets`) have a Smart Score `>= SMART_WALLET_MIN_SCORE` — computed by the gather layer, which cross-references `getMarketTraderWallets` against `getLatestScoresForWallets`. */
  smartWalletCount: number;
  /** `undefined` only if this market wasn't in the set passed to `getMarketSignalCounts` — in practice always present with `{0, 0}` for a market with no whale/consensus signals (see that function's own doc comment). */
  signalCounts: MarketSignalCounts | undefined;
}

export interface TrendingMarket {
  marketId: string;
  eventTitle: string | null;
  /** 0-100. Not comparable to Trending Wallet Score's 0-100 scale — a different question about a different kind of entity. */
  trendingScore: number;
  reason: string[];
  recentTradeCount: number;
  recentVolumeUsd: string;
  uniqueWallets: number;
  smartWallets: number;
  whaleSignalCount: number;
  consensusSignalCount: number;
  lastActivityAt: Date;
}

export interface TrendingMarketScoreConfig {
  /** Relative trade-count increase (recent vs. previous window) that earns full "growth" credit. Default 2 (a 200% increase = 3x). */
  growthMultiplierForFullCredit?: number;
}

const DEFAULT_GROWTH_MULTIPLIER_FOR_FULL_CREDIT = 2;
/** Cumulative recent-window USD volume at or above this (log-scaled) gets full "activity volume" credit. Same default as Trending Wallet Score's own threshold — a single wallet and an entire market are held to the same "$5,000 in one window is meaningful" bar, since both describe one lookback window, not an all-time track record. */
const MEANINGFUL_RECENT_VOLUME_USD = 5_000;
/** Recent-window trade count at or above this gets full "activity trade count" credit — higher than Trending Wallet Score's 10, since a market's trade count is contributed by potentially many wallets at once. */
const MEANINGFUL_RECENT_TRADE_COUNT = 15;
/** Distinct traders in the recent window at or above this gets full "participation" credit — a market only one wallet is touching isn't broadly "trending" regardless of that wallet's own volume. */
const MEANINGFUL_UNIQUE_WALLETS = 5;
/** Same threshold `detectSmartMoneySignals.ts` defaults `minSmartScore` to for `smart_wallet_trade` — "smart" means the same thing here as everywhere else in this project (see `gatherDashboardData.ts`'s identical constant for `activeSmartWallets`). Exported so `gatherTrendingMarketsInput.ts` applies the exact same threshold when cross-referencing trader wallets against their Smart Score, rather than a second hardcoded copy of `35`. */
export const SMART_WALLET_MIN_SCORE = 35;
/** Distinct smart-scored traders at or above this gets full "smart participation" credit. */
const MEANINGFUL_SMART_WALLETS = 2;
const WHALE_SIGNALS_FOR_FULL_CREDIT = 2;
const CONSENSUS_SIGNALS_FOR_FULL_CREDIT = 1;
/** Minutes since the last trade in this market before the "recency" component fully decays to zero — deliberately much shorter than any `lookbackMinutes` a caller might request: this component asks "is this market active in just the last hour", not "was it active sometime in the whole window". */
const RECENCY_DECAY_MINUTES = 60;

const WEIGHTS = {
  activity: 0.2,
  growth: 0.2,
  participation: 0.15,
  smartParticipation: 0.15,
  whale: 0.1,
  consensus: 0.1,
  recency: 0.1,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function computeActivity01(activity: MarketActivityWindow): number {
  const volume = Number(activity.recentVolumeUsd);
  const volumeScore01 =
    volume > 0 ? clamp01(Math.log10(volume + 1) / Math.log10(MEANINGFUL_RECENT_VOLUME_USD + 1)) : 0;
  const countScore01 = clamp01(activity.recentTradeCount / MEANINGFUL_RECENT_TRADE_COUNT);
  return (volumeScore01 + countScore01) / 2;
}

/** Same shape as Trending Wallet Score's `computeGrowth01` — `1` (full credit) for a brand-new burst with no previous-window baseline, otherwise the capped relative increase. */
function computeGrowth01(
  activity: MarketActivityWindow,
  growthMultiplierForFullCredit: number,
): number {
  if (activity.recentTradeCount === 0) return 0;
  if (activity.previousTradeCount === 0) return 1;
  const relativeIncrease =
    (activity.recentTradeCount - activity.previousTradeCount) / activity.previousTradeCount;
  return clamp01(relativeIncrease / growthMultiplierForFullCredit);
}

function computeParticipation01(activity: MarketActivityWindow): number {
  return clamp01(activity.uniqueWallets / MEANINGFUL_UNIQUE_WALLETS);
}

function computeSmartParticipation01(smartWalletCount: number): number {
  return clamp01(smartWalletCount / MEANINGFUL_SMART_WALLETS);
}

function computeWhale01(signalCounts: MarketSignalCounts | undefined): number {
  return signalCounts ? clamp01(signalCounts.whaleTradeCount / WHALE_SIGNALS_FOR_FULL_CREDIT) : 0;
}

function computeConsensus01(signalCounts: MarketSignalCounts | undefined): number {
  return signalCounts
    ? clamp01(signalCounts.marketConsensusCount / CONSENSUS_SIGNALS_FOR_FULL_CREDIT)
    : 0;
}

function computeRecency01(activity: MarketActivityWindow, now: Date): number {
  const minutesSinceLastActivity =
    (now.getTime() - activity.lastActivityAt.getTime()) / (1000 * 60);
  return clamp01(1 - minutesSinceLastActivity / RECENCY_DECAY_MINUTES);
}

function buildReasons(
  activity: MarketActivityWindow,
  smartWalletCount: number,
  signalCounts: MarketSignalCounts | undefined,
  recency01: number,
): string[] {
  const reasons: string[] = [];

  reasons.push(
    `${activity.recentTradeCount} trade(s) totaling $${activity.recentVolumeUsd} from ${activity.uniqueWallets} distinct wallet(s) in the lookback window.`,
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

  if (smartWalletCount > 0) {
    reasons.push(`${smartWalletCount} smart-scored wallet(s) (Smart Score >= 35) trading here.`);
  }

  if (signalCounts && signalCounts.whaleTradeCount > 0) {
    reasons.push(`${signalCounts.whaleTradeCount} whale-trade signal(s) in this window.`);
  }

  if (signalCounts && signalCounts.marketConsensusCount > 0) {
    reasons.push(
      `${signalCounts.marketConsensusCount} market-consensus signal(s) formed on this market.`,
    );
  }

  if (recency01 > 0) {
    reasons.push('Active within the last hour.');
  }

  return reasons;
}

export function computeTrendingMarketScore(
  input: TrendingMarketInput,
  now: Date = new Date(),
  config: TrendingMarketScoreConfig = {},
): TrendingMarket {
  const growthMultiplierForFullCredit =
    config.growthMultiplierForFullCredit ?? DEFAULT_GROWTH_MULTIPLIER_FOR_FULL_CREDIT;

  const { activity, smartWalletCount, signalCounts } = input;

  const activity01 = computeActivity01(activity);
  const growth01 = computeGrowth01(activity, growthMultiplierForFullCredit);
  const participation01 = computeParticipation01(activity);
  const smartParticipation01 = computeSmartParticipation01(smartWalletCount);
  const whale01 = computeWhale01(signalCounts);
  const consensus01 = computeConsensus01(signalCounts);
  const recency01 = computeRecency01(activity, now);

  const blended01 =
    activity01 * WEIGHTS.activity +
    growth01 * WEIGHTS.growth +
    participation01 * WEIGHTS.participation +
    smartParticipation01 * WEIGHTS.smartParticipation +
    whale01 * WEIGHTS.whale +
    consensus01 * WEIGHTS.consensus +
    recency01 * WEIGHTS.recency;

  return {
    marketId: activity.marketId,
    eventTitle: activity.eventTitle,
    trendingScore: Math.round(clamp01(blended01) * 100),
    reason: buildReasons(activity, smartWalletCount, signalCounts, recency01),
    recentTradeCount: activity.recentTradeCount,
    recentVolumeUsd: activity.recentVolumeUsd,
    uniqueWallets: activity.uniqueWallets,
    smartWallets: smartWalletCount,
    whaleSignalCount: signalCounts?.whaleTradeCount ?? 0,
    consensusSignalCount: signalCounts?.marketConsensusCount ?? 0,
    lastActivityAt: activity.lastActivityAt,
  };
}

/**
 * Scores every input and sorts descending by `trendingScore`, with two
 * deterministic tie-breakers (`recentVolumeUsd` desc, then `marketId`
 * ascending) — same reasoning as Trending Wallet Score's
 * `rankTrendingWallets`: `Array.prototype.sort` is stable per spec, but
 * only helps if ties are broken by something meaningful.
 */
export function rankTrendingMarkets(
  inputs: TrendingMarketInput[],
  now: Date = new Date(),
  config: TrendingMarketScoreConfig = {},
): TrendingMarket[] {
  const scored = inputs.map((input) => computeTrendingMarketScore(input, now, config));

  scored.sort((a, b) => {
    if (b.trendingScore !== a.trendingScore) return b.trendingScore - a.trendingScore;
    const volumeDiff = Number(b.recentVolumeUsd) - Number(a.recentVolumeUsd);
    if (volumeDiff !== 0) return volumeDiff;
    return a.marketId.localeCompare(b.marketId);
  });

  return scored;
}
