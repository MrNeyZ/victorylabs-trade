# Smart Money Signals

Phase 3.5/3.6. The first "something interesting just happened" layer on
top of Smart Score (`docs/smart-score.md`, Phase 3.2) and its persisted
history (Phase 3.3). Where `wallet_score_snapshots` answers "is this
wallet good", this phase answers "did a good wallet (or a market) just do
something worth noticing".

Phase 3.5 built pure detection, computed live on every call, nothing
persisted. Phase 3.6 (§6) added a `smart_money_signals` table and a
persist job, and made `GET /api/signals/recent` read from it by default —
live recomputation is still available (`?source=live`), it's just no
longer the default.

Backend-analytics only, per this phase's brief — no frontend, no
deployment, no alerting yet.

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

### 4.1 CLI — `npm run analytics:signals` (detect only, no writes)

```bash
npm run analytics:signals
npm run analytics:signals -- --lookbackMinutes=120 --minSmartScore=50 --consensusWallets=4 --whaleUsd=5000
```

Defaults: `lookbackMinutes=60`, `minSmartScore=35`, `consensusWallets=3`,
`whaleUsd=1000` (also overridable via `ANALYTICS_SIGNALS_LOOKBACK_MINUTES`/
`ANALYTICS_SIGNALS_MIN_SMART_SCORE`/`ANALYTICS_SIGNALS_CONSENSUS_WALLETS`/
`ANALYTICS_SIGNALS_WHALE_USD` env vars, CLI flags take precedence). Prints
one summary line then the full `Signal[]` as JSON. **No database writes**
— read-only, same as `analytics:leaderboard`. See §6.2 for
`analytics:signals:persist`, the write-capable sibling of this command.

### 4.2 API — `GET /api/signals/recent`

Read-only either way (`source=persisted` reads a table; `source=live`
recomputes — neither one writes anything).

| Param | Default | Notes |
|---|---|---|
| `source` | `persisted` | `persisted` reads `smart_money_signals` (§6); `live` recomputes on this request, same behavior this route had before Phase 3.6. |
| `lookbackMinutes` | 60 | Max 1440 (24h). Filters `occurred_at` in both modes. |
| `minSmartScore` | 35 | Any finite number. **`live` mode only** — see note below. |
| `limit` | 50 | Max 200 — caps the returned signal list (not the trades considered, in `live` mode). |

`source=persisted` response:

```jsonc
{
  "source": "persisted",
  "lookbackMinutes": 60,
  "limit": 50,
  "signals": [ /* PersistedSignal[], most-recent occurredAt first */ ]
}
```

`source=live` response (unchanged from Phase 3.5, plus the new `source`/
`limit` echo fields):

```jsonc
{
  "source": "live",
  "lookbackMinutes": 60,
  "minSmartScore": 35,
  "limit": 50,
  "tradesConsidered": 214,
  "signals": [ /* Signal[], most-recent occurredAt first */ ]
}
```

**Why `minSmartScore` only appears in the `live` response**: in
`persisted` mode, `minSmartScore` was already applied — at whatever value
`analytics:signals:persist` used when each row was written — and can't be
meaningfully re-applied at read time (a persisted `market_consensus`
signal's `walletPubkeys` is already the qualifying subset; there's no
per-signal "score" column to filter a mixed-wallet signal against, only
`scoreContext`, which is per-wallet). `source=persisted` simply ignores a
`minSmartScore` query param if one is passed, rather than erroring — a
real per-wallet-score filter on already-persisted signals would need to
query into `scoreContext` itself, which is a narrower future feature
(§7), not a straightforward column filter. `consensusWallets`/`whaleUsd`
were never exposed as query params on this route either way (kept at
their defaults in `live` mode; baked into whatever was persisted in
`persisted` mode) — the CLI is the tool for exploring those two.

## 5. Limitations

- **No scheduled persistence.** `analytics:signals:persist` (§6) is still
  a bounded, manually-invoked CLI job, same constraint as every other job
  in this project (see `docs/mvp-status.md`) — the `smart_money_signals`
  table only stays fresh if someone (or a future cron-style scheduler,
  still not built) re-runs it.
- **No deduplication beyond exact-id collision.** Idempotency (§6.3)
  only prevents the *exact same* signal (same type/market/side/trade or
  wallet-set) from being inserted twice. Two structurally different
  signals about the same real-world event (e.g. `smart_wallet_trade` and
  `whale_trade` on the same trade) are NOT deduplicated against each
  other — deliberately (see §1, "not a duplicate of the others").
- **No alerting.** Nothing pushes a persisted signal anywhere (webhook,
  log, notification) — persistence just means "queryable later", not
  "someone gets notified".
- **Same ingestion-coverage caveat as everywhere else** in this project:
  a signal can only fire on a trade this project actually ingested (the
  live `/trades` poller) and a wallet actually scored
  (`analytics:scores` must have run for that wallet at some point). A
  perfectly real smart-money trade this project never polled produces no
  signal, persisted or otherwise.
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
- **`persisted` reads can lag `live` reads.** Whatever
  `analytics:signals:persist` last detected is what `source=persisted`
  returns — a genuinely new signal that would show up under
  `source=live` right now isn't in `smart_money_signals` until the
  persist job runs again.

## 6. Persistence (Phase 3.6)

### 6.1 Schema

`smart_money_signals` (`src/backend/db/migrations/004_smart_money_signals.sql`):

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | The detector's own deterministic `Signal.id` (§2.4) — not a surrogate key. This is what makes `ON CONFLICT (id) DO NOTHING` work as idempotency (§6.3). |
| `type` | `TEXT NOT NULL` (`CHECK` enum) | One of the four signal types (§1). |
| `severity` | `TEXT NOT NULL` (`CHECK` enum) | `low` \| `medium` \| `high`. |
| `wallet_pubkeys` | `TEXT[] NOT NULL` | Every wallet involved — one for single-trade signal types, 3+ for `market_consensus`. |
| `market_id` | `TEXT` (nullable) | Nullable in the schema even though every signal type detected so far always has one — future-proofing for a non-market-scoped signal type, not a gap in today's data. |
| `side` | `TEXT` (nullable, `CHECK` enum) | Same nullability reasoning as `market_id`. |
| `event_title` | `TEXT` (nullable) | |
| `amount_usd` | `NUMERIC` (nullable) | |
| `score_context` | `JSONB NOT NULL` | `Signal.scoreContext` verbatim. |
| `occurred_at` | `TIMESTAMPTZ NOT NULL` | |
| `explanation` | `TEXT NOT NULL` | |
| `raw` | `JSONB NOT NULL` | The full `Signal` object as detected, verbatim — a safety net against any field not (yet) promoted to its own column, same role `raw` plays on every ingestion-facing table since `001_init.sql`. Written, never read back (same convention as every other `raw` column in this project). |
| `inserted_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Row-write bookkeeping, distinct from `occurred_at`'s logical trade/consensus time. |

Indexed on `occurred_at DESC` (recency reads), `type`, `severity`,
`market_id` (btree — each is a plain equality filter), and
`wallet_pubkeys` (**GIN**, not btree — an array column queried for
containment, `WHERE wallet_pubkeys @> ARRAY[$1]`, needs a GIN index over
the array's elements; a btree index would only help exact-whole-array
equality, which nothing here needs).

### 6.2 The persist job

`src/backend/jobs/persistSmartMoneySignals.ts` (`npm run
analytics:signals:persist`) has the exact same configuration surface as
`analytics:signals` (§4.1: `lookbackMinutes`/`minSmartScore`/
`consensusWallets`/`whaleUsd`, same CLI flags and env vars) plus one more
step: it calls `signalsRepository.upsertSignals` on whatever the detector
returns. Output:

```
[analytics:signals:persist] lookbackMinutes=60 minSmartScore=35 consensusWallets=3 whaleUsd=1000
[analytics:signals:persist] fetched=214 detected=6 inserted=6 duplicates=0 durationMs=812
```

`fetched` = trades considered, `detected` = signals the pure detector
returned, `inserted` = genuinely new rows, `duplicates` = detected
signals whose `id` already existed (see §6.3). Like every other analytics
job in this project: no Jupiter API calls, bounded one-shot run, no loop,
no daemon, no PM2.

### 6.3 Idempotency

Every `Signal.id` is a deterministic, content-derived string (§2.4) — no
`Date.now()`/`Math.random()` anywhere in the detector. `upsertSignals` is
`ON CONFLICT (id) DO NOTHING`, so running `analytics:signals:persist`
twice over an overlapping (or identical) lookback window re-detects the
same underlying signals but inserts 0 new rows for any signal already
persisted. This is a different mechanism from
`wallet_score_snapshots`/`analytics:scores`'s idempotency (there, a
5-minute-bucketed `snapshotAt` timestamp is what collides on re-run;
here, the signal's own content is) but the same outcome: re-running the
job is always safe, never produces duplicate rows.

Verified live (Phase 3.6): two back-to-back `analytics:signals:persist`
runs with lowered thresholds (to force real signals in a small throwaway
dataset) detected the same signal set both times; the first inserted N
new rows, the second inserted 0 (all N reported as duplicates).

### 6.4 Repository

`src/backend/db/repositories/signalsRepository.ts`:

- `upsertSignals(signals)` — bulk insert, `ON CONFLICT (id) DO NOTHING`,
  returns the count of genuinely new rows.
- `getRecentSignals({ lookbackMinutes, limit, type, severity, marketId })`
  — read path for `GET /api/signals/recent?source=persisted` (§4.2).
  Returns `PersistedSignal[]`, a variant of `Signal` with `marketId`/
  `side`/`amountUsd` typed nullable (matching the schema's honest
  nullability — see §6.1) rather than forced to a fake non-null default.

## 7. Future work

Not built yet; the natural next steps, roughly in order:

1. **A scheduled persist job** (still no PM2/Docker per this project's
   standing constraints — see `docs/mvp-status.md`) that runs
   `analytics:signals:persist` on an interval, instead of only on manual
   invocation.
2. **`GET /api/signals/history`** for a single wallet or market, mirroring
   `getWalletScoreHistory`'s read pattern — signals over time for one
   entity, not just "everything recent".
3. **A `scoreContext`-aware filter** for `source=persisted` — letting
   `minSmartScore` mean something for persisted reads (e.g. "only
   persisted signals where at least one `scoreContext` entry meets this
   score"), addressing the gap noted in §4.2.
4. **Outbound alerting** (webhook/Slack/Discord) gated on severity, now
   that persistence exists to prevent the same signal from being
   re-alerted every time someone calls a read endpoint over an
   overlapping window.
5. **Signal-quality feedback loop** — once real usage exists, track
   which signals actually preceded a market resolving favorably, to
   start calibrating severity thresholds against outcomes instead of
   hand-picked multipliers.
