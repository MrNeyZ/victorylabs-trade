# Smart Money Signals

Phase 3.5. The first "something interesting just happened" layer on top
of Smart Score (`docs/smart-score.md`, Phase 3.2) and its persisted
history (Phase 3.3). Where `wallet_score_snapshots` answers "is this
wallet good", this phase answers "did a good wallet (or a market) just do
something worth noticing" — computed live over a recent trade window, not
persisted (see §5 for why).

Backend-analytics only, per this phase's brief — no frontend, no
deployment, no persisted signals table, no alerting yet.

---

## 1. Signal types

Four independent detectors, all defined in
`src/backend/analytics/signals/detectSmartMoneySignals.ts`. A single
trade can trigger more than one — e.g. a $5,000 trade from a
Smart-Score-90 wallet is simultaneously a `smart_wallet_trade`, an
`elite_wallet_trade`, *and* a `whale_trade`. Each is real, independently
useful information; this is not deduplicated.

| Type | Trigger | Severity |
|---|---|---|
| `smart_wallet_trade` | A wallet with `latestSmartScore.score >= minSmartScore` (default 35) made a trade in the lookback window. | `high` if score ≥ 75, `medium` if score ≥ 55, else `low`. |
| `elite_wallet_trade` | A wallet with `latestSmartScore.score >= 75` (fixed — see §2.3) made a trade. | Always `high`. |
| `market_consensus` | 3+ (`consensusWallets`, default 3) distinct wallets with `score >= minSmartScore` traded the **same side of the same market** within the lookback window. | `low` at exactly the threshold, `medium` at +1 wallet, `high` at +2 or more. |
| `whale_trade` | `trade.amountUsd >= whaleUsd` (default $1,000), regardless of the trader's score. | `low` at the threshold, `medium` at 2×, `high` at 5×. |

## 2. Detection logic

### 2.1 Pure/impure split

Same pattern as `computeWalletStats.ts`/`gatherWalletStatsInput.ts`
(Phase 3.1):

- **`gatherSignalDetectionInput.ts`** (impure): fetches every trade with
  `upstream_timestamp` within the last `lookbackMinutes`
  (`tradesRepository.getRecentTradesWithinMinutes` — new this phase),
  collects the distinct wallet pubkeys among them, and fetches each of
  those wallets' most recent persisted Smart Score snapshot in one query
  (`walletScoresRepository.getLatestScoresForWallets` — new this phase,
  `SELECT DISTINCT ON (wallet_pubkey) ... ORDER BY wallet_pubkey,
  snapshot_at DESC`). Wallets with no snapshot at all are simply absent
  from the resulting map — not zero, **unscored**.
- **`detectSmartMoneySignals.ts`** (pure): takes `{ trades, latestScores
  }` plus an optional config (`minSmartScore`/`consensusWallets`/
  `whaleUsd`) and returns `Signal[]`. No I/O, no `Date.now()` (all
  timestamps come from the input trades), deterministic — the same input
  always produces the same output, including `id` (see §2.4).

### 2.2 "Latest score" vs. `/api/scores/latest`

`getLatestScoresForWallets` deliberately does **not** require every
wallet to share the same `snapshot_at` bucket the way
`getLatestWalletScores` (Phase 3.3, `/api/scores/latest`) does. A wallet
that traded 30 seconds ago may not have been included in the most recent
`analytics:scores` run yet; signal detection wants "the latest score we
have for this wallet, whenever it was computed", not "wallets scored in
lockstep this round". This is a real, accepted staleness: if
`analytics:scores` hasn't run recently, `smart_wallet_trade`/
`elite_wallet_trade`/`market_consensus` all key off however old that
snapshot is.

### 2.3 Why `elite_wallet_trade`'s threshold (75) isn't configurable

The CLI/API only expose four tunable knobs: `lookbackMinutes`,
`minSmartScore`, `consensusWallets`, `whaleUsd`. The 75-point elite
threshold is a fixed constant
(`ELITE_SMART_SCORE_THRESHOLD` in `detectSmartMoneySignals.ts`) — it
happens to equal `computeWalletScore.ts`'s own tier threshold for
`"elite"`, but is defined independently on purpose: retuning the scoring
engine's tier boundaries later should not silently retune what this
signal calls "elite" out from under anyone already depending on it.

### 2.4 Signal `id`s are deterministic, not random

Every `id` is a plain string built from the signal's own content (type +
marketId + side + a stable per-type key — the triggering trade's `id`
for single-trade signals, the sorted wallet-pubkey list for
`market_consensus`). No `Date.now()`/`Math.random()` anywhere in the
detector, so the same trade/score snapshot always produces the exact
same signal `id` — useful for future deduplication once persistence
exists (§5), and keeps the pure detector actually pure/testable today.

### 2.5 `market_consensus` grouping

Trades in the window are grouped by `(marketId, side)`. Within each
group, only trades from wallets meeting `minSmartScore` count; a wallet
trading the same side multiple times in the window is still one wallet,
not multiple "votes" (`walletPubkeys` is deduplicated). If the count of
distinct qualifying wallets reaches `consensusWallets`, one
`market_consensus` signal is emitted for that market+side, with:

- `walletPubkeys` — every qualifying wallet, sorted.
- `amountUsd` — the **sum** of `amountUsd` across only the qualifying
  wallets' trades in that group (not the market's total volume,
  including non-smart traders).
- `occurredAt` — the most recent contributing trade's `upstreamTimestamp`
  (i.e. when the threshold was most recently reinforced).

There is no separate "consensus window" parameter — consensus is
evaluated over the same `lookbackMinutes` window already used to fetch
the trades, not an independently configurable sub-window.

## 3. Signal shape

```ts
interface Signal {
  id: string;
  type: 'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';
  severity: 'low' | 'medium' | 'high';
  walletPubkeys: string[];
  marketId: string;
  side: 'yes' | 'no';
  eventTitle: string | null;
  amountUsd: string;           // decimal string, see docs/analytics-engine.md's money convention
  scoreContext: { walletPubkey: string; score: number; tier: WalletScoreTier }[];
  occurredAt: string;          // ISO timestamp over the wire
  explanation: string;
}
```

`scoreContext` has one entry per wallet in `walletPubkeys`, in the same
order. For `whale_trade` specifically, score is not a detection
criterion — `scoreContext` is populated purely for display (score `0` /
tier `"unknown"` if the wallet has never been scored).

## 4. Surfaces

### 4.1 CLI — `npm run analytics:signals`

```bash
npm run analytics:signals
npm run analytics:signals -- --lookbackMinutes=120 --minSmartScore=50 --consensusWallets=4 --whaleUsd=5000
```

Defaults: `lookbackMinutes=60`, `minSmartScore=35`, `consensusWallets=3`,
`whaleUsd=1000` (also overridable via `ANALYTICS_SIGNALS_LOOKBACK_MINUTES`/
`ANALYTICS_SIGNALS_MIN_SMART_SCORE`/`ANALYTICS_SIGNALS_CONSENSUS_WALLETS`/
`ANALYTICS_SIGNALS_WHALE_USD` env vars, CLI flags take precedence). Prints
one summary line then the full `Signal[]` as JSON. **No database writes**
— read-only, same as `analytics:leaderboard`.

### 4.2 API — `GET /api/signals/recent`

Read-only, computed live on every request (not a cached/persisted read
like `/api/scores/latest`).

| Param | Default | Notes |
|---|---|---|
| `lookbackMinutes` | 60 | Max 1440 (24h). |
| `minSmartScore` | 35 | Any finite number. |
| `limit` | 50 | Max 200 — applied to the final sorted signal list, not to the trades considered. |

Response:

```jsonc
{
  "lookbackMinutes": 60,
  "minSmartScore": 35,
  "tradesConsidered": 214,
  "signals": [ /* Signal[], most-recent occurredAt first */ ]
}
```

`consensusWallets`/`whaleUsd` are not exposed as query params on this
route (kept at their defaults, 3 and 1000) — only the two params the
brief for this phase actually calls out (`lookbackMinutes`,
`minSmartScore`) are wired through the API; the CLI is the tool for
exploring the other two.

## 5. Limitations

- **Not persisted.** Every call to the CLI or `/api/signals/recent`
  recomputes signals from scratch over the current window — there is no
  `signals` table, no history, no "signals I've already seen" state. Two
  requests a minute apart over an overlapping window can (and will)
  report the same underlying trade again.
- **No deduplication/alerting.** Nothing pushes a signal anywhere
  (webhook, log, notification) — this phase is detection only, on
  request.
- **Same ingestion-coverage caveat as everywhere else** in this project:
  a signal can only fire on a trade this project actually ingested (the
  live `/trades` poller) and a wallet actually scored
  (`analytics:scores` must have run for that wallet at some point). A
  perfectly real smart-money trade this project never polled produces no
  signal.
- **`market_consensus` has no cross-market correlation.** Each market+side
  is judged independently; a wallet spreading conviction across several
  closely-related markets (e.g. different strikes of the same event)
  doesn't count toward consensus on any single one of them.
- **Severity thresholds are new, un-calibrated heuristics** (same caveat
  `docs/smart-score.md` already gives its own thresholds) — reasonable
  defaults, not backtested against a labeled "this mattered" dataset.
- **`whale_trade` ignores the trader's history entirely.** A wallet
  making one $1,000 trade and then never trading again looks identical
  to a wallet that does this daily — no rate-of-whale-activity signal
  exists yet.

## 6. Future persistence/alerts plan

Not built this phase; the natural next steps, roughly in order:

1. **A `smart_money_signals` table**, same shape as
   `wallet_score_snapshots` (Phase 3.3) — persist each detected signal
   keyed by its deterministic `id` (`ON CONFLICT (id) DO NOTHING`, same
   idempotency pattern already used everywhere else in this project) so
   re-running detection over an overlapping window doesn't duplicate
   signals already recorded.
2. **A scheduled detection job** (still no PM2/Docker per this project's
   standing constraints — see `docs/mvp-status.md`) that runs
   `analytics:signals`-equivalent logic on an interval and writes new
   signals as they're found, instead of only computing on demand.
3. **`GET /api/signals/history`** once persisted, mirroring
   `getWalletScoreHistory`'s read pattern — signals over time, not just
   "right now".
4. **Outbound alerting** (webhook/Slack/Discord) gated on severity —
   deliberately out of scope until persistence exists, so the same
   signal isn't re-alerted every time someone happens to call the
   detector over an overlapping window.
5. **Signal-quality feedback loop** — once real usage exists, track
   which signals actually preceded a market resolving favorably, to
   start calibrating severity thresholds against outcomes instead of
   hand-picked multipliers.
