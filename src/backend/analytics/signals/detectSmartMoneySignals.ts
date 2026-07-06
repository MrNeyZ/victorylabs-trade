/**
 * VictoryLabs Smart Money Signals — Phase 3.5. Pure detection over a
 * window of already-fetched trades plus each involved wallet's latest
 * persisted Smart Score (Phase 3.3). No I/O of any kind: the caller
 * (`./gatherSignalDetectionInput.ts`) is responsible for fetching recent
 * trades and scores from Postgres; this file only ever sees plain
 * objects/arrays and returns plain objects. Same pure/impure split as
 * `computeWalletStats.ts`/`gatherWalletStatsInput.ts`.
 *
 * Four independent detectors run over the same trade window — a single
 * trade can produce more than one signal (e.g. an elite wallet's
 * $5,000 trade is simultaneously a `smart_wallet_trade`, an
 * `elite_wallet_trade`, AND a `whale_trade`; each is real, independently
 * useful information, not a duplicate of the others). See
 * `docs/smart-money-signals.md` for the full writeup of each signal type
 * and severity scale.
 *
 * Money fields that are genuine output amounts (`Signal.amountUsd`) stay
 * decimal strings (`sumDecimalStrings`, `../../utils/decimal.ts`) — the
 * same exception `computeWalletScore.ts` already documents applies here
 * too: converting `amountUsd`/the configured USD thresholds to `Number`
 * purely for a `>=` comparison is fine (nothing here is money arithmetic
 * written back to storage), but summed/reported dollar amounts are not.
 */
import type { Trade, TradeSide } from '../../types/domain.js';
import type { WalletScoreTier } from '../scoring/computeWalletScore.js';
import type { WalletScoreSnapshotResult } from '../../db/repositories/walletScoresRepository.js';
import { sumDecimalStrings } from '../../utils/decimal.js';

export type SignalType =
  'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';

export type SignalSeverity = 'low' | 'medium' | 'high';

export interface SignalScoreContextEntry {
  walletPubkey: string;
  score: number;
  tier: WalletScoreTier;
}

export interface Signal {
  /** Deterministic, content-derived — same inputs always produce the same id, no random/clock component (keeps this detector pure and its output reproducible/diffable across runs). Not a database key; nothing here is persisted yet (see docs/smart-money-signals.md §5). */
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  /** One wallet for `smart_wallet_trade`/`elite_wallet_trade`/`whale_trade`; every distinct qualifying wallet (2 or more) for `market_consensus`. */
  walletPubkeys: string[];
  marketId: string;
  side: TradeSide;
  eventTitle: string | null;
  /** The triggering trade's `amountUsd` for single-trade signal types; the summed `amountUsd` across every contributing trade for `market_consensus`. */
  amountUsd: string;
  /** One entry per wallet in `walletPubkeys`, same order. */
  scoreContext: SignalScoreContextEntry[];
  /** The triggering trade's `upstreamTimestamp` for single-trade signals; the most recent contributing trade's `upstreamTimestamp` for `market_consensus`. */
  occurredAt: Date;
  explanation: string;
}

export interface DetectSmartMoneySignalsInput {
  /** Trades already scoped to the detection window — this module does not filter by time itself (see `gatherSignalDetectionInput.ts`). */
  trades: Trade[];
  /** Each involved wallet's latest known Smart Score snapshot, keyed by `walletPubkey`. A wallet with no entry is treated as unscored — never counted toward `smart_wallet_trade`/`elite_wallet_trade`/`market_consensus` (it can still trigger `whale_trade`, which has no score requirement). */
  latestScores: Map<string, WalletScoreSnapshotResult>;
}

export interface DetectSmartMoneySignalsConfig {
  /** Minimum `latestSmartScore.score` for `smart_wallet_trade` and for counting toward `market_consensus`. Default 35. */
  minSmartScore?: number;
  /** Minimum distinct qualifying wallets trading the same side of the same market for `market_consensus`. Default 3. */
  consensusWallets?: number;
  /** Minimum `trade.amountUsd` (converted to `Number` for comparison only) for `whale_trade`. Default 1000. */
  whaleUsd?: number;
}

const DEFAULT_MIN_SMART_SCORE = 35;
const DEFAULT_CONSENSUS_WALLETS = 3;
const DEFAULT_WHALE_USD = 1000;

/**
 * Fixed at 75 — the `elite_wallet_trade` threshold is a defining property
 * of that signal type per this phase's brief, not one of the CLI-tunable
 * defaults (`lookbackMinutes`/`minSmartScore`/`consensusWallets`/
 * `whaleUsd`). It happens to equal `computeWalletScore.ts`'s own
 * `TIER_SCORE_THRESHOLDS.elite`, but is defined independently here on
 * purpose — retuning the scoring engine's tier boundaries should not
 * silently retune what this signal considers "elite".
 */
const ELITE_SMART_SCORE_THRESHOLD = 75;

function scoreContextFor(
  walletPubkeys: string[],
  latestScores: Map<string, WalletScoreSnapshotResult>,
): SignalScoreContextEntry[] {
  return walletPubkeys.map((walletPubkey) => {
    const snapshot = latestScores.get(walletPubkey);
    return {
      walletPubkey,
      score: snapshot?.score ?? 0,
      tier: snapshot?.tier ?? 'unknown',
    };
  });
}

function signalId(type: SignalType, marketId: string, side: TradeSide, key: string): string {
  return `${type}:${marketId}:${side}:${key}`;
}

function detectSmartWalletTrade(
  trade: Trade,
  score: WalletScoreSnapshotResult,
  minSmartScore: number,
  latestScores: Map<string, WalletScoreSnapshotResult>,
): Signal | null {
  if (score.score < minSmartScore) return null;
  return {
    id: signalId('smart_wallet_trade', trade.marketId, trade.side, trade.id),
    type: 'smart_wallet_trade',
    severity:
      score.score >= ELITE_SMART_SCORE_THRESHOLD ? 'high' : score.score >= 55 ? 'medium' : 'low',
    walletPubkeys: [trade.ownerPubkey],
    marketId: trade.marketId,
    side: trade.side,
    eventTitle: trade.eventTitle,
    amountUsd: trade.amountUsd,
    scoreContext: scoreContextFor([trade.ownerPubkey], latestScores),
    occurredAt: trade.upstreamTimestamp,
    explanation: `Wallet ${trade.ownerPubkey} (Smart Score ${score.score}, tier ${score.tier}) ${trade.action === 'buy' ? 'bought' : 'sold'} ${trade.side.toUpperCase()} on market ${trade.marketId} for $${trade.amountUsd}.`,
  };
}

function detectEliteWalletTrade(
  trade: Trade,
  score: WalletScoreSnapshotResult,
  latestScores: Map<string, WalletScoreSnapshotResult>,
): Signal | null {
  if (score.score < ELITE_SMART_SCORE_THRESHOLD) return null;
  return {
    id: signalId('elite_wallet_trade', trade.marketId, trade.side, trade.id),
    type: 'elite_wallet_trade',
    severity: 'high',
    walletPubkeys: [trade.ownerPubkey],
    marketId: trade.marketId,
    side: trade.side,
    eventTitle: trade.eventTitle,
    amountUsd: trade.amountUsd,
    scoreContext: scoreContextFor([trade.ownerPubkey], latestScores),
    occurredAt: trade.upstreamTimestamp,
    explanation: `Elite wallet ${trade.ownerPubkey} (Smart Score ${score.score}) ${trade.action === 'buy' ? 'bought' : 'sold'} ${trade.side.toUpperCase()} on market ${trade.marketId} for $${trade.amountUsd}.`,
  };
}

/** Score is NOT a criterion for `whale_trade` — `latestScores` is only consulted to populate `scoreContext` for context/display, same as every other signal's `scoreContext`. A whale trade from an unscored wallet still fires, with `scoreContext` reporting score 0 / tier "unknown". */
function detectWhaleTrade(
  trade: Trade,
  whaleUsd: number,
  latestScores: Map<string, WalletScoreSnapshotResult>,
): Signal | null {
  const amount = Number(trade.amountUsd);
  if (amount < whaleUsd) return null;
  const severity: SignalSeverity =
    amount >= whaleUsd * 5 ? 'high' : amount >= whaleUsd * 2 ? 'medium' : 'low';
  return {
    id: signalId('whale_trade', trade.marketId, trade.side, trade.id),
    type: 'whale_trade',
    severity,
    walletPubkeys: [trade.ownerPubkey],
    marketId: trade.marketId,
    side: trade.side,
    eventTitle: trade.eventTitle,
    amountUsd: trade.amountUsd,
    scoreContext: scoreContextFor([trade.ownerPubkey], latestScores),
    occurredAt: trade.upstreamTimestamp,
    explanation: `Whale trade: wallet ${trade.ownerPubkey} ${trade.action === 'buy' ? 'bought' : 'sold'} ${trade.side.toUpperCase()} on market ${trade.marketId} for $${trade.amountUsd} (>= $${whaleUsd} threshold).`,
  };
}

interface MarketSideGroupKey {
  marketId: string;
  side: TradeSide;
}

function groupTradesByMarketSide(
  trades: Trade[],
): Map<string, { key: MarketSideGroupKey; trades: Trade[] }> {
  const groups = new Map<string, { key: MarketSideGroupKey; trades: Trade[] }>();
  for (const trade of trades) {
    const groupKey = `${trade.marketId}:${trade.side}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.trades.push(trade);
    } else {
      groups.set(groupKey, {
        key: { marketId: trade.marketId, side: trade.side },
        trades: [trade],
      });
    }
  }
  return groups;
}

function detectMarketConsensus(
  trades: Trade[],
  latestScores: Map<string, WalletScoreSnapshotResult>,
  minSmartScore: number,
  consensusWallets: number,
): Signal[] {
  const signals: Signal[] = [];

  for (const { key, trades: groupTrades } of groupTradesByMarketSide(trades).values()) {
    const qualifyingTradesByWallet = new Map<string, Trade[]>();
    for (const trade of groupTrades) {
      const score = latestScores.get(trade.ownerPubkey);
      if (score === undefined || score.score < minSmartScore) continue;
      const existing = qualifyingTradesByWallet.get(trade.ownerPubkey);
      if (existing) {
        existing.push(trade);
      } else {
        qualifyingTradesByWallet.set(trade.ownerPubkey, [trade]);
      }
    }

    const qualifyingWallets = Array.from(qualifyingTradesByWallet.keys()).sort();
    if (qualifyingWallets.length < consensusWallets) continue;

    const contributingTrades = qualifyingWallets.flatMap(
      (walletPubkey) => qualifyingTradesByWallet.get(walletPubkey) ?? [],
    );
    const occurredAt = contributingTrades.reduce(
      (latest, trade) => (trade.upstreamTimestamp > latest ? trade.upstreamTimestamp : latest),
      contributingTrades[0]!.upstreamTimestamp,
    );
    const eventTitle =
      contributingTrades.find((trade) => trade.eventTitle !== null)?.eventTitle ?? null;
    const extraWallets = qualifyingWallets.length - consensusWallets;
    const severity: SignalSeverity =
      extraWallets >= 2 ? 'high' : extraWallets >= 1 ? 'medium' : 'low';

    signals.push({
      id: signalId('market_consensus', key.marketId, key.side, qualifyingWallets.join(',')),
      type: 'market_consensus',
      severity,
      walletPubkeys: qualifyingWallets,
      marketId: key.marketId,
      side: key.side,
      eventTitle,
      amountUsd: sumDecimalStrings(contributingTrades.map((trade) => trade.amountUsd)),
      scoreContext: scoreContextFor(qualifyingWallets, latestScores),
      occurredAt,
      explanation: `${qualifyingWallets.length} wallets with Smart Score >= ${minSmartScore} traded ${key.side.toUpperCase()} on market ${key.marketId} in the same window.`,
    });
  }

  return signals;
}

export function detectSmartMoneySignals(
  input: DetectSmartMoneySignalsInput,
  config: DetectSmartMoneySignalsConfig = {},
): Signal[] {
  const minSmartScore = config.minSmartScore ?? DEFAULT_MIN_SMART_SCORE;
  const consensusWallets = config.consensusWallets ?? DEFAULT_CONSENSUS_WALLETS;
  const whaleUsd = config.whaleUsd ?? DEFAULT_WHALE_USD;

  const { trades, latestScores } = input;
  const signals: Signal[] = [];

  for (const trade of trades) {
    const score = latestScores.get(trade.ownerPubkey);
    if (score !== undefined) {
      const smartSignal = detectSmartWalletTrade(trade, score, minSmartScore, latestScores);
      if (smartSignal) signals.push(smartSignal);

      const eliteSignal = detectEliteWalletTrade(trade, score, latestScores);
      if (eliteSignal) signals.push(eliteSignal);
    }

    const whaleSignal = detectWhaleTrade(trade, whaleUsd, latestScores);
    if (whaleSignal) signals.push(whaleSignal);
  }

  signals.push(...detectMarketConsensus(trades, latestScores, minSmartScore, consensusWallets));

  signals.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return signals;
}
