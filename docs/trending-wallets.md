# Trending Wallet Discovery

Phase 4.1. A second ranking heuristic alongside Smart Score
(`docs/smart-score.md`), computed purely over data earlier phases already
persisted (`trades`, `wallet_score_snapshots`, `smart_money_signals`) —
no new ingestion, no new Jupiter API calls, no new writes.

---

## 1. Philosophy

Smart Score answers **"is this wallet good, historically"** — and is
deliberately conservative: hard-gated by sample size and realized losses,
built to resist a single lucky trade looking like skill
(`docs/smart-score.md` §1).

Trending Score answers a different question: **"is this wallet becoming
interesting RIGHT NOW."** These are not the same axis, and a wallet can
score high on one and near-zero on the other:

- A wallet with a flawless 6-month track record that hasn't traded in two
  weeks has an excellent Smart Score and a near-zero Trending Score —
  nothing about it is "happening right now."
- A wallet that opened its very first position an hour ago and has
  already made five trades and a whale-sized bet has almost no Smart
  Score (barely any sample to judge) but a high Trending Score — it's
  new activity worth a human's attention, regardless of whether it turns
  out to be skill or luck.

This is the explicit, stated goal: **not "best wallet," "wallets becoming
interesting right now."** Smart Score is only one of six inputs into
Trending Score, and it's weighted *lower* than the two signals that
directly measure "is something happening right now" (activity, growth) —
see §2.2.

## 2. Formula

Computed by `src/backend/analytics/trending/computeTrendingScore.ts`,
purely from a per-wallet `TrendingWalletInput` (its recent/previous
activity window, its latest Smart Score if any, and its recent
whale/consensus signal counts — see §3 for how these are gathered).

### 2.1 The six components (each 0-1 internally, blended, then ×100)

| Component | What it measures | Computed from |
|---|---|---|
| `activity` | How much is happening in the lookback window — average of log-scaled recent volume (full credit at $5,000+) and recent trade count (full credit at 10+ trades). | `recentVolumeUsd`, `recentTradeCount` |
| `growth` | Is this MORE than before — relative increase in trade count vs. the *previous* window of equal length. `1.0` (full credit) if there was zero activity in the previous window but some now (a brand-new burst has no ratio to compute); otherwise the relative increase, capped at a 200%-increase-for-full-credit default. `0` if there's no recent activity at all. | `recentTradeCount` vs. `previousTradeCount` |
| `novelty` | How recently this wallet first appeared at all — linear decay from 1.0 (first trade today) to 0.0 (7+ days since its first-ever trade). | first trade timestamp (unbounded — see §3.1) |
| `smartScore` | The wallet's existing Smart Score, `0` if never scored. Deliberately the smallest-weighted "quality" input, not a gate — an unscored or low-scored wallet can still trend. | `wallet_score_snapshots` (latest, any bucket) |
| `whale` | Recent `whale_trade` signals this wallet appears in — full credit at 2+. | `smart_money_signals` |
| `consensus` | Recent `market_consensus` signals this wallet appears in — full credit at 1+ (being part of *any* multi-wallet consensus is already notable). | `smart_money_signals` |

### 2.2 The blend

```
trendingScore = round(100 × (
    0.30 × growth
  + 0.25 × activity
  + 0.15 × novelty
  + 0.10 × smartScore
  + 0.10 × whale
  + 0.10 × consensus
))
```

No multiplicative gates (unlike Smart Score's sample-size/loss gates) —
every component here is additive. That's a deliberate difference: Smart
Score's gates exist to *disqualify* wallets that look good but aren't
proven; Trending Score isn't claiming a wallet is proven, only that it's
worth a look right now, so there's nothing to gate against. `growth`
(0.30) and `activity` (0.25) together make up 55% of the score —
Trending Score is primarily about *what's happening now*, with novelty,
Smart Score, and the two signal types filling in supporting context.

### 2.3 `reason[]`

Every `TrendingWallet` includes a plain-English `reason` array (not a
single string), built by `buildReasons()` — one line per component that
actually contributed something, in the same order as the table above
(activity always present; growth/novelty/smartScore/whale/consensus only
when non-zero). Same philosophy as `computeWalletScore.ts`'s
`explanations` array: a human should be able to read *why* a wallet
ranked where it did without re-deriving the math.

## 3. How it's assembled

Same pure/impure split as every other analytics module in this project
(`computeWalletScore.ts`/`gatherWalletStatsInput.ts`,
`detectSmartMoneySignals.ts`/`gatherSignalDetectionInput.ts`):

- **`gatherTrendingInput.ts`** (impure): fetches up to 500 candidate
  wallets — every wallet with at least one trade in the lookback window —
  via `tradesRepository.getWalletActivityWindows`, then each candidate's
  latest Smart Score (`walletScoresRepository.getLatestScoresForWallets`,
  the same "each wallet's own latest snapshot, not bucket-locked"
  function `gatherSignalDetectionInput.ts` already uses) and recent
  whale/consensus signal counts (`signalsRepository.getWalletSignalCounts`,
  new this phase) in parallel.
- **`computeTrendingScore.ts`** (pure): `computeTrendingScore()` scores
  one wallet; `rankTrendingWallets()` scores a whole list and sorts it
  (see §3.2 for the sort).

### 3.1 Why `firstTradeAt` isn't bounded to the lookback window

`getWalletActivityWindows` deliberately does **not** restrict its base
query to the lookback window — `first_trade_at` (used for the `novelty`
component) needs to be each wallet's genuine first-ever trade, not just
the earliest one inside an arbitrary query bound. A long-time trader
who happens to have `2 × lookbackMinutes` worth of trades would otherwise
look "brand new" purely because the query never looked further back.
This means the query scans the whole `trades` table rather than a
time-bounded slice — see §5 for the scale caveat and the real fix.

### 3.2 Ranking and tie-breaking

`rankTrendingWallets()` sorts descending by `trendingScore`, with two
deterministic tie-breakers: `recentVolumeUsd` descending, then
`walletPubkey` ascending. `Array.prototype.sort` is stable per spec, but
that only helps if ties are broken by something meaningful — without
these, two wallets scoring identically would order however they
happened to come back from the database that particular request, which
would look like the ranking was "shuffling" between otherwise-identical
API calls. With them, the same input always produces the same order.

## 4. API

### `GET /api/trending/wallets`

Computed live on every request (like `/api/signals/recent?source=live`)
— there is no persisted `trending_wallets` table; this phase's brief was
explicit that Trending Score uses only already-persisted *inputs*, not
that its own output needs persisting too.

| Param | Default | Max |
|---|---|---|
| `lookbackMinutes` | 1440 (24h) | 10080 (7 days) |
| `limit` | 20 | 100 |

Response:

```jsonc
{
  "lookbackMinutes": 1440,
  "limit": 20,
  "wallets": [
    {
      "walletPubkey": "...",
      "trendingScore": 78,
      "reason": [
        "6 trade(s) totaling $412.30 in the lookback window.",
        "New burst of activity — no trades in the previous equivalent window.",
        "First trade seen today — a brand-new participant.",
        "1 whale-trade signal(s) in this window."
      ],
      "latestSmartScore": 12,
      "recentTradeCount": 6,
      "recentVolumeUsd": "412.300000",
      "lastActivityAt": "2026-07-06T21:20:00.000Z"
    }
  ]
}
```

## 5. Limitations

- **`firstTradeAt` scans the whole `trades` table** (§3.1) — correct but
  not scale-tested. The real fix is populating the still-unused `wallets`
  dimension table's `first_seen_at` column (defined in `001_init.sql`,
  never written to by anything — confirmed dead in this codebase) on
  ingestion, so this query becomes an indexed point lookup per wallet
  instead of an unbounded aggregate scan. Out of scope this phase (`Do
  NOT modify ingestion jobs`).
- **"Previous window" is a fixed equal-length comparison**, not a longer
  historical baseline — a wallet that's been steadily active for months
  and just happens to trade slightly more this hour than last hour can
  score similarly to one going from zero to something. There's no
  seasonality/baseline-normalization here.
- **No cross-wallet calibration.** Every score is computed independently
  against fixed absolute thresholds ($5,000 "meaningful volume", 10
  trades, a 200%-for-full-credit growth multiplier, a 7-day novelty
  window) — reasonable starting points, not backtested against a labeled
  "this was actually interesting" dataset (same caveat Smart Score's own
  thresholds carry).
- **Same ingestion-coverage caveat as everywhere else** in this project:
  a wallet can only appear here if this project's own `/trades` poller
  actually captured its activity — not a census of real Jupiter
  Prediction activity.
- **No persistence, no history.** Every request recomputes from scratch;
  there's no "trending 3 hours ago" to compare against, and two requests
  a minute apart can (and will) reorder as new trades land.
- **`whale`/`consensus` signal counts depend on `analytics:signals:persist`
  having run recently** (`docs/smart-money-signals.md`) — if it hasn't,
  those two components are silently `0` for everyone, not flagged as
  stale.

## 6. Future improvements

- **Populate `wallets.first_seen_at`/`last_seen_at`** during ingestion
  (a genuinely separate, small change to the ingestion layer, explicitly
  out of scope this phase) so `novelty` becomes an indexed lookup instead
  of an unbounded scan, and so "first appearance" reflects the very first
  time this project saw the wallet in *any* context (trade, position,
  leaderboard, profile), not only its first trade.
- **Persisted trending snapshots**, mirroring `wallet_score_snapshots`
  (Phase 3.3) — once scored on a schedule, `reason`/`trendingScore` could
  be tracked over time, letting a future UI show "this wallet has been
  trending for the last 3 hours" instead of only a single live snapshot.
- **A longer rolling baseline for `growth`**, instead of a single
  equal-length "previous window" — e.g. comparing the recent window
  against a 7-day median instead of just the immediately preceding hour,
  to reduce noise from wallets with naturally bursty (but not novel)
  trading patterns.
- **Outcome-aware calibration**, once there's a labeled dataset of
  "wallets that were actually worth noticing" — the same future work
  `docs/smart-money-signals.md` §7 already names for signal severity
  thresholds applies here too.
- **Cross-reference with `market_consensus` markets** — a wallet trending
  because it just joined a market three other smart wallets are already
  active in is a stronger signal than one trending in isolation; today
  the `consensus` component only counts *how many* consensus signals a
  wallet is in, not whether its trending activity and its consensus
  participation are the same event.
