# Trending Market Discovery

Phase 4.2. The market-scoped sibling of Trending Wallet Discovery
(`docs/trending-wallets.md`, Phase 4.1) — same underlying question
("what's becoming interesting RIGHT NOW", not "what's the best"), applied
to markets instead of wallets. Computed purely over data earlier phases
already persisted (`trades`, `wallet_score_snapshots`,
`smart_money_signals`) — no new ingestion, no new Jupiter API calls, no
new writes, and (per this phase's brief) no changes to Smart Score or
Trending Wallet Score.

---

## 1. Philosophy

A market can be "hot" for reasons a single wallet's Trending Score
can't see: many *different* wallets converging on it, a sudden spike in
combined volume, or a cluster of already-flagged signals (whale trades,
consensus) all pointing at the same event. Trending Wallet Score answers
"is this wallet doing something interesting"; Trending Market Score
answers **"is this market where the interesting things are happening"** —
a genuinely different aggregation, not a derived average of the wallets
trading it.

Two signals here have no wallet-side equivalent:

- **Participation** — how many *distinct* wallets are touching this
  market right now. A market one wallet is trading back and forth isn't
  broadly interesting; a market five independent wallets all picked up
  in the same hour is.
- **Smart participation** — how many of those distinct traders are
  themselves Smart-Score-qualified wallets. A market only unscored/new
  wallets are touching looks different from one several proven wallets
  are also active in.

Conversely, this module has no "novelty" component the way Trending
Wallet Score does (`docs/trending-wallets.md` §2.1) — "when did this
market first appear" wasn't one of the signals this phase's brief asked
for, and a market's first appearance doesn't carry the same "brand-new
participant" meaning a wallet's does.

## 2. Formula

Computed by
`src/backend/analytics/trendingMarkets/computeTrendingMarketScore.ts`,
purely from a per-market `TrendingMarketInput` (its recent/previous
activity window including distinct-trader count, how many of those
traders are smart-scored, and its recent whale/consensus signal counts —
see §3 for how these are gathered).

### 2.1 The seven components (each 0-1 internally, blended, then ×100)

| Component | What it measures | Computed from |
|---|---|---|
| `activity` | How much is happening in the lookback window — average of log-scaled recent volume (full credit at $5,000+) and recent trade count (full credit at 15+ trades — higher than Trending Wallet Score's 10, since a market's trades are contributed by potentially many wallets at once). | `recentVolumeUsd`, `recentTradeCount` |
| `growth` | Is this MORE than before — relative increase in trade count vs. the *previous* window of equal length. `1.0` for a brand-new burst (zero previous-window activity), otherwise the capped relative increase (200% default for full credit). `0` if there's no recent activity. | `recentTradeCount` vs. `previousTradeCount` |
| `participation` | Distinct wallets trading this market in the recent window — full credit at 5+. | `COUNT(DISTINCT owner_pubkey)` |
| `smartParticipation` | How many of those distinct traders have a Smart Score >= 35 (the same "smart" threshold used everywhere else in this project) — full credit at 2+. | `wallet_score_snapshots`, cross-referenced against this market's trader list |
| `whale` | Recent `whale_trade` signals with this `market_id` — full credit at 2+. | `smart_money_signals` |
| `consensus` | Recent `market_consensus` signals with this `market_id` — full credit at 1+. | `smart_money_signals` |
| `recency` | Is this active in just the last **hour**, not merely somewhere in the whole lookback window — linear decay from 1.0 (last trade just now) to 0.0 (60+ minutes since the last trade). | `lastActivityAt` |

### 2.2 The blend

```
trendingScore = round(100 × (
    0.20 × activity
  + 0.20 × growth
  + 0.15 × participation
  + 0.15 × smartParticipation
  + 0.10 × whale
  + 0.10 × consensus
  + 0.10 × recency
))
```

No multiplicative gates, same reasoning as Trending Wallet Score
(`docs/trending-wallets.md` §2.2): nothing here is claiming a market is
*good*, only that it's worth a look right now, so there's nothing to
disqualify against. `activity` and `growth` together are 40% of the
score — same "what's happening now matters most" emphasis Trending
Wallet Score gives its own two highest-weighted components, just split
slightly more evenly here across seven components instead of six.

### 2.3 Why `recency` exists here but not on Trending Wallet Score

Trending Wallet Score's `activity`/`growth` already imply recency (a
wallet with zero previous-window activity and some now is inherently
"just started"). A market behaves differently: a market can have a
respectable trade count spread evenly across a 24-hour lookback window
with its *last* trade 20 hours ago — genuinely less "hot right now" than
one with fewer total trades, all in the last 10 minutes. `recency`
exists specifically to separate "active sometime in the window" from
"active right now", decaying over a fixed 60-minute horizon regardless of
how large `lookbackMinutes` itself is requested.

### 2.4 `reason[]`

Every `TrendingMarket` includes a plain-English `reason` array, built by
`buildReasons()` — one line per component that actually contributed
something (activity always present; the rest only when non-zero), same
philosophy as Trending Wallet Score's own `reason[]`
(`docs/trending-wallets.md` §2.3).

## 3. How it's assembled

Same pure/impure split as every other analytics module in this project:

- **`gatherTrendingMarketsInput.ts`** (impure): fetches up to 500
  candidate markets — every market with at least one trade in the
  lookback window — via `tradesRepository.getMarketActivityWindows` (the
  market-grouped counterpart to Phase 4.1's
  `getWalletActivityWindows`, including `COUNT(DISTINCT owner_pubkey)` as
  `uniqueWallets`). It then fetches each candidate market's distinct
  trader wallets (`tradesRepository.getMarketTraderWallets`, new this
  phase) and recent whale/consensus signal counts
  (`signalsRepository.getMarketSignalCounts`, new this phase — the
  market-scoped counterpart to Phase 4.1's `getWalletSignalCounts`, but
  simpler: `market_id` is a plain scalar column, not an array, so no
  `unnest` is needed). Every distinct trader across every candidate
  market is scored in one batched
  `walletScoresRepository.getLatestScoresForWallets` call, then each
  market's `smartWalletCount` is computed by counting how many of *its*
  traders cleared the threshold.
- **`computeTrendingMarketScore.ts`** (pure): `computeTrendingMarketScore()`
  scores one market; `rankTrendingMarkets()` scores a whole list and sorts
  it (see §3.1 for the sort).

### 3.1 Ranking and tie-breaking

`rankTrendingMarkets()` sorts descending by `trendingScore`, with two
deterministic tie-breakers: `recentVolumeUsd` descending, then `marketId`
ascending — identical reasoning to `rankTrendingWallets()`
(`docs/trending-wallets.md` §3.2): `Array.prototype.sort` is stable per
spec, but only helps if ties are broken by something meaningful.

### 3.2 Why `getMarketActivityWindows` bounds its scan (unlike the wallet version)

`getWalletActivityWindows` (Phase 4.1) deliberately scans the *entire*
`trades` table, unbounded, because it needs each wallet's genuine
first-ever trade for the "novelty" component. `getMarketActivityWindows`
has no such component — nothing here needs data older than
`2 × lookbackMinutes` — so its base query IS bounded to that window,
keeping it cheap on a `trades` table that only grows over time.

## 4. API

### `GET /api/trending/markets`

Same router as `/api/trending/wallets`
(`src/backend/api/routes/trending.ts`), computed live on every request —
no `trending_markets` table.

| Param | Default | Max |
|---|---|---|
| `lookbackMinutes` | 1440 (24h) | 10080 (7 days) |
| `limit` | 20 | 100 |

Response:

```jsonc
{
  "lookbackMinutes": 1440,
  "limit": 20,
  "markets": [
    {
      "marketId": "POLY-2810572-0",
      "eventTitle": "Hyperliquid Up or Down - July 6, 4:00PM-4:05PM ET",
      "trendingScore": 74,
      "reason": [
        "9 trade(s) totaling $612.40 from 6 distinct wallet(s) in the lookback window.",
        "Trade count up 200% vs. the previous window (3 → 9).",
        "2 smart-scored wallet(s) (Smart Score >= 35) trading here.",
        "1 whale-trade signal(s) in this window.",
        "1 market-consensus signal(s) formed on this market.",
        "Active within the last hour."
      ],
      "recentTradeCount": 9,
      "recentVolumeUsd": "612.400000",
      "uniqueWallets": 6,
      "smartWallets": 2,
      "whaleSignalCount": 1,
      "consensusSignalCount": 1,
      "lastActivityAt": "2026-07-06T21:20:00.000Z"
    }
  ]
}
```

## 5. Limitations

- **No cross-wallet calibration.** Every score is computed independently
  against fixed absolute thresholds ($5,000 volume, 15 trades, 5 unique
  wallets, 2 smart wallets, a 60-minute recency horizon) — reasonable
  starting points, not backtested against a labeled "this market was
  actually interesting" dataset (same caveat every scoring module in
  this project carries).
- **`smartWalletCount` only counts traders who cleared the threshold at
  the time of this request** — a market that had 3 smart wallets trading
  it an hour ago but whose scores have since been recomputed downward
  (or who traded before their most recent `analytics:scores` run) may
  under- or over-count relative to "how smart were the traders when they
  actually traded."
- **`participation`/`smartParticipation` only look at the recent window**,
  not the previous one — there's no "gained 3 new distinct traders vs.
  last window" signal, only an absolute recent-window count.
- **Same ingestion-coverage caveat as everywhere else** in this project:
  a market can only appear here if this project's own `/trades` poller
  actually captured trades on it — not a census of real Jupiter
  Prediction market activity.
- **No persistence, no history.** Every request recomputes from scratch;
  two requests a minute apart can (and will) reorder as new trades land,
  same as Trending Wallet Score.
- **`whale`/`consensus` signal counts depend on `analytics:signals:persist`
  having run recently** — if it hasn't, those two components are
  silently `0` for every market, not flagged as stale (same caveat
  `docs/trending-wallets.md` §5 already documents for the wallet version).

## 6. Future improvements

- **Persisted trending-market snapshots**, mirroring the same future
  work already named for Trending Wallet Score
  (`docs/trending-wallets.md` §6) — tracking `trendingScore` over time
  per market instead of only a single live snapshot.
- **Link trending markets back to trending wallets** — today these are
  two independent rankings; a market trending *because* several
  independently-trending wallets just converged on it is a stronger
  combined signal than either ranking alone shows.
- **A `market_id` detail page** (explicitly out of scope this phase —
  "no market page yet") — once one exists, `reason[]` and the per-market
  breakdown already computed here would populate it directly, similar to
  how `docs/wallet-intelligence-api.md`'s `marketBreakdown` feeds the
  wallet detail page.
- **Event-level aggregation** — several `marketId`s can share one
  `eventTitle` (e.g. different strikes/outcomes of the same event); this
  phase scores each `marketId` independently, with no notion of "this
  whole event is heating up" across its sibling markets.
- **Outcome-aware calibration**, once there's a labeled dataset of
  "markets that were actually worth noticing" — same future work
  `docs/smart-money-signals.md` §7 and `docs/trending-wallets.md` §6
  already name for their own thresholds.
