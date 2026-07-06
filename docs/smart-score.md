# VictoryLabs Smart Score

Phase 3.2/3.3. The first ranking heuristic in VictoryLabs Trade — a
conservative 0-100 score over a wallet's `WalletStats`
(`src/backend/analytics/walletStats/computeWalletStats.ts`, Phase 3.1),
computed by `src/backend/analytics/scoring/computeWalletScore.ts`. This
document explains the philosophy, the exact formula, its known
limitations, and where it's expected to improve next.

---

## 1. Scoring philosophy

The brief for this phase was explicit: **be conservative**. A "smart
money" score is only useful if it resists two specific failure modes
this project has direct instructions to avoid:

1. **A wallet with 1 lucky trade must not rank elite.** One winning bet
   is not evidence of skill — it's a coin flip that happened to land
   right. A score that can't tell the difference between "consistently
   good" and "got lucky once" is worse than no score at all.
2. **A wallet actively losing money must not rank as trustworthy**,
   regardless of how active, diversified, or recent its trading is.
   Activity is not the same thing as being *right*.

Both are enforced as **hard multiplicative gates** on the final score,
not just as one weighted component among several. That distinction
matters mechanically: if sample size or realized losses were only one
input to a weighted average, a wallet could still compensate with high
scores elsewhere (heavy activity, perfect diversification, very recent
trading) and land in "strong" territory despite having essentially no
real track record, or a clearly negative one. Multiplying the *entire*
blended score by these gates means neither failure mode is escapable by
being good at something else.

Every other signal (profitability beyond the loss gate, consistency,
activity, recency) is a **weighted blend**, not a gate — being merely
"okay, not great" on one of those shouldn't tank an otherwise solid
wallet the way a real loss or a tiny sample does.

## 2. Formula

### 2.1 The five components (each 0-100 in the output)

| Component | What it measures | Computed from |
|---|---|---|
| `profitability` | Realized ROI (`realizedPnlUsd / totalVolumeUsd`), clamped to ±100% and mapped linearly to 0-100 (50 = breakeven). `0` if there's no volume to compute a ratio from. | `WalletStats.realizedPnlUsd`, `totalVolumeUsd` |
| `consistency` | Average of (a) the fraction of known positions that are actually resolved (`closedPositions / (closedPositions + currentOpenPositions)`, `0` if no position data exists) and (b) market diversification (`totalMarkets` capped at a target of 5, linearly). | `WalletStats.closedPositions`, `currentOpenPositions`, `totalMarkets` |
| `activity` | Average of three sub-scores, each capped at 1.0: log-scaled cumulative volume (full credit at $10,000+), trade count (full credit at 20+ trades), and active days (full credit at 10+ distinct days). | `WalletStats.totalVolumeUsd`, `totalTrades`, `activeDays` |
| `recency` | Linear decay from 1.0 (traded today) to 0.0 (14+ days since the last trade). `0` if there's no trade at all. | `WalletStats.lastTrade` |
| `sampleSize` | `totalTrades / 30`, capped at 1.0 — the standard small-sample statistical rule-of-thumb minimum, not tuned against this project's own data. | `WalletStats.totalTrades` |

### 2.2 The blend

```
blended = 0.40 × profitability
        + 0.25 × consistency
        + 0.20 × activity
        + 0.15 × recency
```

Weights reflect the priority order in the brief: profitability matters
most, but only if the evidence behind it (consistency) and the amount of
evidence (activity) support trusting it; recency matters least of the
four, since a genuinely great historical wallet shouldn't be zeroed out
just for a quiet week.

### 2.3 The two gates

```
lossGate      = 1                          if ROI >= 0 or no volume
              = clamp(1 + ROI, 0, 1)^2      if ROI < 0   (ROI itself already clamped to >= -1)

sampleSizeGate = sampleSize component (0.0-1.0, see table above)

finalScore = round( blended × sampleSizeGate × lossGate × 100 )
```

The loss gate is **squared** deliberately: a wallet down 2% (probably
noise) barely loses anything extra (`(1-0.02)^2 ≈ 0.96`), while a wallet
down 25%+ of its traded volume is punished hard
(`(1-0.25)^2 ≈ 0.56`, `(1-0.50)^2 = 0.25`). This is separate from — and
stacks with — the `profitability` component already scoring lower for
the same loss within the blend; the gate exists specifically so that
strong scores elsewhere can never fully compensate for it.

### 2.4 Tiers

```
totalTrades === 0        -> unknown   (no data, not merely "bad")
score >= 75               -> elite
score >= 55                -> strong
score >= 35                 -> watch
otherwise (score < 35)       -> weak
```

`unknown` is checked first and is not just "score near zero" — it's a
distinct semantic state for "we have no trade data on this wallet at
all," so a wallet we simply haven't seen yet is never confused with one
we've observed losing money or trading too little to trust.

## 3. Worked examples (from this phase's own verification)

| Scenario | Result | Why |
|---|---|---|
| One trade, +90% ROI, otherwise-perfect stats | score 2, **weak** | `sampleSize` component is `1/30 ≈ 0.03`; gating the whole blend by that crushes an otherwise-perfect score to near-zero. |
| 60 trades, +16% ROI, 12 markets, 25 active days, traded today | score 82, **elite** | Meets every meaningful-activity threshold; no gate fires. |
| 40 trades, **-25% ROI**, otherwise strong activity/consistency/recency | score 42, **watch** (would be 74/"strong" with the loss gate removed) | The loss gate alone moved this wallet down two full tiers, exactly the intended effect — real losses aren't washable by unrelated activity. |
| Zero trades ingested | score 0, **unknown** | No data, correctly distinct from "weak". |

## 4. Limitations

- **Every input is only as complete as this project's own ingestion.** A
  wallet whose `positions`/`history_events` were never fetched will score
  its `consistency` component from market diversification alone (or `0`
  entirely) — not because it's inconsistent, but because there's no
  position data to judge it by. `computeWalletScore`'s `explanations`
  array says so explicitly per wallet, but the number itself doesn't
  distinguish "actually inconsistent" from "we don't know."
- **Thresholds are reasonable defaults, not calibrated against this
  project's real wallet-score distribution.** $10,000 "meaningful
  volume," 20 trades, 10 active days, a 30-trade sample-size floor, and a
  14-day recency window are all defensible starting points, not the
  result of backtesting against known-good/known-bad wallets (there is
  no labeled ground truth to backtest against yet).
- **No decay/adjustment for market difficulty.** A wallet that only bets
  on near-certain (e.g. $0.95+) outcomes will show a high win rate and
  positive ROI with very little actual predictive skill; this score has
  no notion of "how hard was the bet," only whether it paid off.
- **Recency has no hard floor.** A wallet with a flawless record that
  goes quiet for months can still reach "elite" on `profitability` +
  `consistency` + `activity` alone if those three are maxed
  (`0.40+0.25+0.20 = 0.85` blend even at zero recency) — recency is
  weighted, not gated, unlike sample size and realized losses. This was
  a deliberate scope decision: the brief named sample size and negative
  PnL as things to explicitly disallow/penalize, not staleness, and
  gating on it too aggressively risked demoting a genuinely proven wallet
  just for a brief quiet period.
- **No cross-wallet calibration.** Every score is computed independently;
  there's no normalization against the current population of scored
  wallets (e.g. percentile rank), so "elite" today might mean something
  different once ingestion coverage is much wider.

## 5. Future improvements

- **Win-rate-aware consistency**, once `WalletStats` (or a richer input)
  exposes per-trade/per-position outcome data rather than only aggregate
  sums — true win rate and its variance would be a much stronger
  consistency signal than the current resolved-ratio/diversification
  proxy.
- **Price-difficulty-adjusted profitability** — weighting a correct
  contrarian bet (bought at $0.10, resolved YES) higher than a correct
  favorite bet (bought at $0.95, resolved YES), since both currently look
  identical to `realizedPnlUsd`.
- **Trend-aware recency/consistency**, now that Phase 3.3 persists a
  snapshot history — `recency`/`consistency` could be judged against a
  wallet's *own* trend over time (`getWalletScoreHistory`), not just the
  single snapshot `computeWalletScore` currently sees.
- **Percentile-based tiers**, once there's a large enough scored
  population that relative ranking is more meaningful than fixed
  absolute thresholds.
- **Feed this into `src/backend/analytics/marketStats/`** once it
  exists, to also account for which markets a wallet's edge shows up in.

## 6. Persistence and API (Phase 3.3)

Phase 3.2 only computed scores in-memory (`npm run analytics:leaderboard`,
print-only, no database write). Phase 3.3 adds a persisted, queryable
snapshot history on top of the same `computeWalletScore`/
`computeWalletStats` — no change to the scoring formula itself.

### 6.1 Schema

`wallet_score_snapshots` (`src/backend/db/migrations/003_wallet_score_snapshots.sql`)
is a genuine time series, one row per `(wallet_pubkey, snapshot_at)` —
same shape of design as `leaderboard_snapshots` (see `001_init.sql`): the
whole point of tracking scores on a schedule is watching them change, not
just holding the latest.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PRIMARY KEY` | Surrogate key — no natural upstream id for a score. |
| `wallet_pubkey` | `TEXT NOT NULL` | |
| `snapshot_at` | `TIMESTAMPTZ NOT NULL` | Floored to a 5-minute bucket before insert — see §6.2. |
| `score` | `INTEGER NOT NULL` | `WalletScore.score`, 0-100, already gated. |
| `tier` | `TEXT NOT NULL` (`CHECK` enum) | `WalletScore.tier`. |
| `profitability`, `consistency`, `activity`, `recency`, `sample_size` | `INTEGER NOT NULL` each | `WalletScore.components.*`, each 0-100, pre-gate. |
| `explanation` | `JSONB NOT NULL` | `WalletScore.explanations` (string array) verbatim. |
| `stats` | `JSONB NOT NULL` | The full `WalletStats` object the score was computed from — the input, not just the output, is kept so a stored score is fully explainable later without re-deriving it. |
| `inserted_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Row-write bookkeeping, distinct from `snapshot_at`'s bucketed logical time. |

`UNIQUE (wallet_pubkey, snapshot_at)` is the idempotency mechanism (§6.2).
Indexed on `snapshot_at DESC`, `score DESC`, `tier`, and `wallet_pubkey`
for the read paths in §6.4/§6.5.

### 6.2 The scoring job

`src/backend/jobs/computeWalletScores.ts` (`npm run analytics:scores`,
optionally `-- --max=<n>`, default 500 candidate wallets):

1. Gathers candidate wallets the same way `analytics:leaderboard` does
   (`gatherCandidateWallets`), capped at `max`.
2. Floors `snapshotAt` to a 5-minute bucket (`SNAPSHOT_BUCKET_MS`, same
   `floorToBucket` helper `ingestLeaderboards.ts` already uses) **once**,
   up front — every wallet scored in one run shares the same bucket.
3. Computes `WalletStats` + `WalletScore` per wallet sequentially (not
   `Promise.all`-ed, same pool-sizing reasoning as
   `analytics:leaderboard`).
4. Bulk-inserts one row per wallet via
   `insertWalletScoreSnapshots` (`ON CONFLICT (wallet_pubkey, snapshot_at)
   DO NOTHING`).

Re-running the job inside the same 5-minute window is therefore a no-op:
every row collides with one already written for that bucket and is
silently skipped, not duplicated. Verified live (Phase 3.3): two
back-to-back runs against the same throwaway database scored 259
candidate wallets both times; the first inserted 259 new rows, the
second inserted 0 (259 reported as duplicates).

Like every other analytics job in this project, it makes zero Jupiter API
calls (pure read of already-ingested Postgres data) and runs exactly
once per invocation — no loop, no daemon, no PM2.

### 6.3 Repository

`src/backend/db/repositories/walletScoresRepository.ts`:

- `insertWalletScoreSnapshots(inputs)` — bulk insert, `ON CONFLICT DO
  NOTHING`, returns the count of genuinely new rows.
- `getLatestWalletScores({ limit, tier, minScore })` — finds the most
  recent `snapshot_at` bucket across all wallets, optionally filters
  within it, orders by `score DESC`.
- `getWalletScoreHistory(walletPubkey)` — full snapshot history for one
  wallet, newest first; `[0]` is also how the wallet-detail route below
  gets "latest".

### 6.4 `GET /api/scores/latest`

Read-only, backed by `getLatestWalletScores` — never computes a score
live. Query params:

| Param | Default | Notes |
|---|---|---|
| `limit` | 50 | Max 200, same convention as `/api/trades/recent`. |
| `tier` | — | One of `elite`/`strong`/`watch`/`weak`/`unknown`; `400 invalid_tier` otherwise. |
| `minScore` | — | Any finite number; `400 invalid_min_score` otherwise. |

Response: `{ snapshotAt, rows: [...] }`, each row shaped like
`WalletScore` plus `walletPubkey`/`snapshotAt`/`stats`. `snapshotAt` is
`null` and `rows` is `[]` if `analytics:scores` has never been run.

### 6.5 `GET /api/wallets/:walletPubkey`

Now also returns `latestSmartScore` — the same shape as one row above, or
`null` if this wallet has never been scored (not an error; consistent
with this route's existing "unknown wallet → 200 with nulls" behavior).
Implemented as `(await getWalletScoreHistory(walletPubkey))[0] ?? null`,
run in the same `Promise.all` as the route's other four lookups.

### 6.6 What Phase 3.3 does not do

- No scheduler — `analytics:scores` is a bounded, manually-invoked CLI
  job, same constraint as every ingestion job in this project (see
  `docs/mvp-status.md`).
- No pruning/retention policy on `wallet_score_snapshots` — it grows by
  (candidate wallets × runs) forever; not addressed here.
- No new frontend surface — `/api/scores/latest` and
  `latestSmartScore` are backend-only per this phase's brief.
