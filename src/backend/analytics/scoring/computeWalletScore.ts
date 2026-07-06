/**
 * VictoryLabs Smart Score — a conservative 0-100 ranking heuristic over a
 * wallet's already-computed `WalletStats` (`../walletStats/computeWalletStats.js`).
 * Pure function: same input always produces the same output (aside from
 * the optional `now` parameter, defaulted to `new Date()` rather than
 * read implicitly, so it stays deterministic when a caller supplies one).
 *
 * One deliberate exception to this project's "money stays a decimal
 * string, never `Number`" rule: this file DOES convert `realizedPnlUsd`/
 * `totalVolumeUsd` to `Number` for ratio/log-scale math. That rule exists
 * to protect stored or transacted monetary values from float precision
 * loss — a 0-100 ranking score is neither; it's a derived display/sort
 * heuristic, and no result here is ever written back as a monetary
 * amount.
 *
 * Philosophy (see `docs/smart-score.md` for the full writeup): be
 * conservative. A wallet's final score is a *weighted blend* of
 * profitability/consistency/activity/recency, then **multiplied by a
 * sample-size gate** — not just averaged in as a fifth component. That
 * multiplication is what actually enforces "a wallet with 1 lucky trade
 * cannot rank elite": even a wallet with a perfect ROI and perfect
 * recency still gets crushed toward zero if `totalTrades` is tiny,
 * because the gate multiplies the whole blended score, not just one
 * fifth of it.
 */
import type { WalletStats } from '../walletStats/computeWalletStats.js';

export type WalletScoreTier = 'elite' | 'strong' | 'watch' | 'weak' | 'unknown';

export interface WalletScoreComponents {
  profitability: number;
  consistency: number;
  activity: number;
  recency: number;
  sampleSize: number;
}

export interface WalletScore {
  walletPubkey: string;
  /** 0-100, already sample-size-gated — this is the number to sort a leaderboard by. */
  score: number;
  tier: WalletScoreTier;
  /** Each 0-100, BEFORE the sample-size gate is applied to the blended total — see module doc comment. */
  components: WalletScoreComponents;
  explanations: string[];
}

/** Realized PnL / volume ("ROI") beyond +/-100% is clamped, not scaled further — a wallet doubling its money and one making 10x look identical here, since anything beyond that is more about bet sizing than sustained skill at this sample. */
const ROI_CLAMP = 1;
/** Distinct markets at or above this count get full "diversification" credit. */
const MARKET_DIVERSIFICATION_TARGET = 5;
/** Cumulative USD volume at or above this (log-scaled) gets full "activity volume" credit. */
const MEANINGFUL_VOLUME_USD = 10_000;
/** Trade count at or above this gets full "activity trade count" credit. */
const MEANINGFUL_TRADE_COUNT = 20;
/** Distinct active days at or above this gets full "activity spread" credit. */
const MEANINGFUL_ACTIVE_DAYS = 10;
/** Trades needed for the sample-size gate to stop penalizing at all — a standard small-sample statistical rule-of-thumb, not tuned against this project's real data. */
const MEANINGFUL_SAMPLE_SIZE = 30;
/** Days since last trade before recency credit decays to zero. */
const RECENCY_WINDOW_DAYS = 14;

const WEIGHTS = {
  profitability: 0.4,
  consistency: 0.25,
  activity: 0.2,
  recency: 0.15,
} as const;

const TIER_SCORE_THRESHOLDS = {
  elite: 75,
  strong: 55,
  watch: 35,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function computeRoi(stats: WalletStats): number | null {
  const totalVolumeUsd = Number(stats.totalVolumeUsd);
  if (!(totalVolumeUsd > 0)) return null;
  return Number(stats.realizedPnlUsd) / totalVolumeUsd;
}

function computeProfitability01(roi: number | null): number {
  if (roi === null) return 0;
  const clampedRoi = Math.max(-ROI_CLAMP, Math.min(ROI_CLAMP, roi));
  // Maps [-1, 1] ROI to [0, 1] score, 0.5 = breakeven.
  return clamp01((clampedRoi + ROI_CLAMP) / (2 * ROI_CLAMP));
}

/**
 * A SECOND, independent penalty for negative realized PnL — multiplies
 * the final score directly, the same mechanism as the sample-size gate,
 * rather than only lowering the profitability component within the
 * weighted blend. Without this, a wallet losing real money could still
 * land in "strong"/"elite" purely by having strong activity/consistency/
 * recency compensate for one merely-below-average profitability
 * component — which is exactly backwards for a "smart money" score,
 * where losing money is disqualifying, not just a mild demerit. No
 * penalty (1.0) when ROI is non-negative or unknown; scales down
 * quadratically as losses approach -100% of traded volume (mild losses
 * near breakeven are barely penalized further; a wallet down 25%+ of its
 * volume is penalized hard).
 */
function computeLossGate01(roi: number | null): number {
  if (roi === null || roi >= 0) return 1;
  const clampedRoi = Math.max(-ROI_CLAMP, roi);
  const linear = clamp01(1 + clampedRoi);
  return linear * linear;
}

function computeConsistency01(stats: WalletStats): number {
  const totalPositionsKnown = stats.currentOpenPositions + stats.closedPositions;
  const resolvedRatio01 =
    totalPositionsKnown > 0 ? clamp01(stats.closedPositions / totalPositionsKnown) : 0;
  const diversification01 = clamp01(stats.totalMarkets / MARKET_DIVERSIFICATION_TARGET);
  return (resolvedRatio01 + diversification01) / 2;
}

function computeActivity01(stats: WalletStats): number {
  const totalVolumeUsd = Number(stats.totalVolumeUsd);
  const volumeScore01 =
    totalVolumeUsd > 0
      ? clamp01(Math.log10(totalVolumeUsd + 1) / Math.log10(MEANINGFUL_VOLUME_USD + 1))
      : 0;
  const tradeCountScore01 = clamp01(stats.totalTrades / MEANINGFUL_TRADE_COUNT);
  const activeDaysScore01 = clamp01(stats.activeDays / MEANINGFUL_ACTIVE_DAYS);
  return (volumeScore01 + tradeCountScore01 + activeDaysScore01) / 3;
}

function computeRecency01(stats: WalletStats, now: Date): number {
  if (!stats.lastTrade) return 0;
  const daysSinceLastTrade = (now.getTime() - stats.lastTrade.getTime()) / (1000 * 60 * 60 * 24);
  return clamp01(1 - daysSinceLastTrade / RECENCY_WINDOW_DAYS);
}

function computeSampleSize01(stats: WalletStats): number {
  return clamp01(stats.totalTrades / MEANINGFUL_SAMPLE_SIZE);
}

function computeTier(stats: WalletStats, score: number): WalletScoreTier {
  if (stats.totalTrades === 0) return 'unknown';
  if (score >= TIER_SCORE_THRESHOLDS.elite) return 'elite';
  if (score >= TIER_SCORE_THRESHOLDS.strong) return 'strong';
  if (score >= TIER_SCORE_THRESHOLDS.watch) return 'watch';
  return 'weak';
}

function buildExplanations(
  stats: WalletStats,
  sampleSize01: number,
  lossGate01: number,
  now: Date,
): string[] {
  if (stats.totalTrades === 0) {
    return [
      'No trades ingested for this wallet yet — score and tier are not meaningful, treat as unknown.',
    ];
  }

  const explanations: string[] = [];
  const totalVolumeUsd = Number(stats.totalVolumeUsd);

  explanations.push(
    totalVolumeUsd > 0
      ? `Realized PnL $${stats.realizedPnlUsd} over $${stats.totalVolumeUsd} volume (~${((Number(stats.realizedPnlUsd) / totalVolumeUsd) * 100).toFixed(1)}% ROI).`
      : 'No trade volume recorded — profitability cannot be assessed.',
  );

  explanations.push(
    `${stats.totalTrades} trade(s) across ${stats.totalMarkets} market(s), ${stats.activeDays} active day(s).`,
  );

  explanations.push(
    stats.totalTrades < MEANINGFUL_SAMPLE_SIZE
      ? `Sample-size penalty applied: ${stats.totalTrades} trade(s) is below the ${MEANINGFUL_SAMPLE_SIZE}-trade confidence threshold (x${sampleSize01.toFixed(2)} multiplier on the final score).`
      : `Sample size meets the ${MEANINGFUL_SAMPLE_SIZE}-trade confidence threshold — no sample-size penalty applied.`,
  );

  if (lossGate01 < 1) {
    explanations.push(
      `Negative-PnL penalty applied: realized losses trigger an additional x${lossGate01.toFixed(2)} multiplier on the final score, independent of the profitability component.`,
    );
  }

  if (stats.lastTrade) {
    const daysAgo = Math.round((now.getTime() - stats.lastTrade.getTime()) / (1000 * 60 * 60 * 24));
    explanations.push(`Last trade ${daysAgo} day(s) ago.`);
  }

  const totalPositionsKnown = stats.currentOpenPositions + stats.closedPositions;
  explanations.push(
    totalPositionsKnown > 0
      ? `${stats.closedPositions}/${totalPositionsKnown} known position(s) resolved.`
      : 'No position data ingested for this wallet — consistency is only assessed via market diversification.',
  );

  if (stats.usedProfileFallbackFor.length > 0) {
    explanations.push(
      `${stats.usedProfileFallbackFor.join(', ')} came from Jupiter's own wallet_profiles aggregate, not this project's own trades/history (no own data existed to reconstruct it).`,
    );
  }

  return explanations;
}

export function computeWalletScore(stats: WalletStats, now: Date = new Date()): WalletScore {
  const roi = computeRoi(stats);
  const profitability01 = computeProfitability01(roi);
  const consistency01 = computeConsistency01(stats);
  const activity01 = computeActivity01(stats);
  const recency01 = computeRecency01(stats, now);
  const sampleSize01 = computeSampleSize01(stats);
  const lossGate01 = computeLossGate01(roi);

  const blended01 =
    profitability01 * WEIGHTS.profitability +
    consistency01 * WEIGHTS.consistency +
    activity01 * WEIGHTS.activity +
    recency01 * WEIGHTS.recency;

  // Two independent gates multiply the whole blend (not just their own
  // weighted component): tiny sample size, and — separately — a real
  // realized loss. Either one alone can keep a wallet out of
  // "strong"/"elite" regardless of how good the rest of the blend looks.
  const finalScore01 = blended01 * sampleSize01 * lossGate01;
  const score = Math.round(finalScore01 * 100);

  return {
    walletPubkey: stats.walletPubkey,
    score,
    tier: computeTier(stats, score),
    components: {
      profitability: Math.round(profitability01 * 100),
      consistency: Math.round(consistency01 * 100),
      activity: Math.round(activity01 * 100),
      recency: Math.round(recency01 * 100),
      sampleSize: Math.round(sampleSize01 * 100),
    },
    explanations: buildExplanations(stats, sampleSize01, lossGate01, now),
  };
}
