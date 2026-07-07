/**
 * Stage 1 Stabilization — Fix 1. The one shared minimum-trade-size
 * constant every trade-surfacing read path filters on, so the number
 * lives in exactly one place instead of being duplicated per call site.
 *
 * $20 is not a guess — it's the recommendation from a real production
 * audit over 952 trades (`docs/trade-distribution-audit.md`): trades
 * below $20 were 64.4% of all observed trades but only 6.9% of total USD
 * volume, while trades >= $20 retain 93.1% of volume. Re-derive this
 * from a fresh audit before changing it, not by feel.
 *
 * Scope: this is a read-path filter only, applied inside the
 * analytics/API layer. It must never reach ingestion, the poller, or the
 * `trades` table schema — every trade, regardless of size, is still
 * ingested and stored. Only reads that surface trades to users (the Live
 * Feed, Smart Money Signals, Trending Wallets, Trending Markets) apply
 * it; Smart Score, wallet pages, and market pages deliberately do not
 * (see each call site for why).
 */
export const MIN_SIGNIFICANT_TRADE_USD = 20;
