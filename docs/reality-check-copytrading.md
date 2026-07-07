# Reality Check — Production Data & Copy-Trading Feasibility Audit

Point-in-time audit against **live production** (`https://trade.victorylabs.app`,
database `vltrade`, PM2 processes `vltrade-backend`/`vltrade-frontend`),
run **2026-07-07, ~14:08 UTC**. Every figure below was pulled from the
production HTTP API, PM2, docs, and the filesystem on the live host — not
from local dev, not simulated. No code, schema, scoring, or UI was
changed to produce this report.

**One access limitation, disclosed up front:** direct `psql` access to
the `vltrade` database was blocked by this environment's own sandbox
(any command touching the DB password, even piped from `.env`, is
auto-denied as credential exposure). Per the user's direction, this audit
proceeded **API-only** for anything the HTTP API exposes, and is
explicit below about the one item (`ingestion_runs` row-by-row history)
that could only be **inferred** from docs/code rather than directly
queried. Nothing else in this report depends on that gap — the live
`trades` table's actual row count, timestamps, and content were all
confirmed through `/api/trades/recent` (a real read of that exact table).

---

## Headline answer

**The production database currently holds a single, frozen, ~9-minute
slice of platform-wide trade activity from initial deployment — nothing
has been ingested since. The live feed is not live. Wallet "quality" data
is a single-trade sample for every wallet in the system. Copy-trading
simulation is not possible on current data**, not because of a schema
gap (most of the necessary columns exist) but because there is no
ongoing ingestion, and the one-time bootstrap it inherited is too small
and disconnected from the wallets worth copying to build anything
trustworthy on top of it.

---

## 1. Production live-feed audit

Measured via `GET /api/trades/recent?limit=200` (the same data
`/api/trades/stream`'s `snapshot` event serves) and `GET /health` at
**2026-07-07T14:08:22Z**.

| Metric | Value |
|---|---|
| Rows returned at `limit=200` | **20** (the entire table — not a limit cap) |
| Latest trade `observedAt` (last time anything was written to `trades`) | `2026-07-06T23:13:39.306Z` |
| Latest trade `upstreamTimestamp` (real Jupiter execution time) | `2026-07-06T23:13:36.000Z` |
| **Lag from now to latest trade** | **~14.9 hours, and growing every minute** |
| Trades in last 5m / 15m / 1h (from *now*) | **0 / 0 / 0** |
| Trades in last 24h (from *now*) | 20 (all of them — the whole table falls inside a 24h lookback purely because "now" is within 24h of the frozen snapshot, not because anything recent happened) |
| Unique wallets (whole table, all time) | 18 |
| Unique markets (whole table, all time) | 15 |
| Span of upstream trade timestamps in the batch | **9.25 minutes** (`23:04:21Z` → `23:13:36Z` on 2026-07-06) |
| Average trades/minute *in that one window* | ~2.2/min (20 trades / 9.25 min) — **not a sustained rate**, see §3 for the real validated figure |
| **Is the data stale?** | **Yes — frozen, not degraded.** All 20 rows share the exact same `observedAt` timestamp to the millisecond (`2026-07-06T23:13:39.306Z`), meaning they were all written by one single ingestion run, not a stream of independent polls. |

**Is the live feed genuinely live? No.** The frontend's SSE connection
(`/api/trades/stream`) is up, healthy, and correctly proxied (confirmed:
`snapshot` event delivers instantly, `heartbeat` fires every 25s) — the
*transport* works. But the poller behind it
(`getTradesSince`, 5s interval) has had zero new rows to find since
deployment, because nothing is feeding new rows into Postgres. A user
watching `/` right now sees a "Live" badge and a table that has not
changed, and will not change, until someone manually re-runs an
ingestion job.

---

## 2. Ingestion audit

**Ingestion is NOT continuous. Saying this clearly, as instructed: the
production database was populated once, at initial deployment, and has
not been touched since.**

Evidence, cross-checked from multiple independent angles:

1. **PM2 process list** (`pm2 jlist`): exactly two VictoryLabs Trade
   processes exist — `vltrade-backend` (the read-only API server) and
   `vltrade-frontend` (Next.js). **No poller/ingestion process.**
2. **`ecosystem.config.cjs`** (version-controlled, defines every PM2 app
   for this project): declares exactly these same two apps. There is no
   third app definition for a poller, anywhere, ever.
3. **cron / systemd**: `crontab -l` for root → "no crontab for root".
   `/etc/cron.d/` has only OS-level entries (`e2scrub_all`, `sysstat`),
   nothing project-related. `systemctl list-timers` shows only stock
   Ubuntu timers (apt, logrotate, man-db, etc.) — no VictoryLabs Trade
   timer/service.
4. **Running processes**: `ps aux` shows no `pollTrades`/`ingest*`
   process running, and no `screen`/`tmux` session exists that could be
   quietly running one in the foreground.
5. **The data itself is the strongest proof**: all 20 rows in `trades`
   share one identical `observed_at` value down to the millisecond. A
   real poller (even a slow one) would produce rows scattered across many
   distinct `observed_at` values over time — one shared timestamp means
   one `INSERT`/`COPY` batch, one moment in time.
6. **The project's own docs already say this, explicitly and repeatedly**:
   - `README.md` §13.3 (Update procedure): *"There is no separate
     'bootstrap ingestion' step in a routine update — that only runs
     once, at initial deployment (§13.5). Ongoing data freshness is a
     known gap... the deployed backend currently only serves whatever
     was last ingested."*
   - `README.md` §13.5 (Initial deployment reference) lists the exact
     one-time bootstrap commands that were run: `ingest:trades:once`,
     `ingest:rankings`, `ingest:positions:recent`, `ingest:history:recent`,
     `analytics:scores`, `analytics:signals:persist` — every one of them
     a bounded, one-shot job, none a `--forever` loop.
   - `docs/monitoring.md` §5: *"'analytics:signals:persist' hasn't been
     re-run in a while... 'no persistent ingestion scheduler yet' is a
     known, accepted gap, not a bug."*
   - `docs/mvp-status.md`: *"No scheduled/always-on ingestion... There is
     no cron, systemd timer, or in-repo scheduler keeping the database
     continuously fresh — recency depends entirely on whoever last ran a
     job."* Listed as the **#3 next-phase priority**, not started.

**`ingestion_runs` table**: this audit could not directly query this
table (see access-limitation note above). Based on the bootstrap command
list in README §13.5 and the "one row per run" design documented in
`001_init.sql`, it is expected to contain a small handful of rows (one
per bootstrap job invocation), all timestamped at the original deploy
moment — **this is inferred from code/docs, not independently confirmed
by row-level query**. If an exact row-by-row audit of `ingestion_runs`
matters before the next engineering phase, that specific query should be
run directly (by a human, or with an explicit permission grant for
Bash-level DB access).

**Is a poller "currently active"? No.** Confirmed by the absence of any
process (§2.1-2.4 above) and by the data having zero variance in
`observed_at` (§2.5).

---

## 3. Source-of-truth audit

**Which endpoint feeds trades?** `GET /trades` on Jupiter's own beta REST
API (`https://api.jup.ag/prediction/v1/trades`), documented in
`docs/jupiter-prediction-discovery.md` as *"Fetch recent platform-wide
trades"* — confirmed against Jupiter's own official reference app
(`jup-ag/api-examples`).

**Is it Jupiter Prediction's REST API?** Yes, directly — not scraped, not
reverse-engineered from on-chain logs.

**Is it Polymarket-sourced through Jupiter?** Partially, by design:
Jupiter Predict aggregates external prediction-market liquidity
(Polymarket, Kalshi) into one Solana-native trading surface. This
explains the `POLY-` prefix on most `marketId`/`eventId` values observed
in production (e.g. `POLY-2069670`, event `POLY-413862`, "2026 FIFA World
Cup: Top Goalscorer") — these are Polymarket-originated markets, traded
through Jupiter's own on-chain order/fill/keeper flow, not raw Polymarket
API data pulled independently.

**Are these real executed trades, or synthetic/display events?** Real.
Two independent confirmations:
- `history_events` rows (where ingested) carry a genuine
  `transaction_signature` — e.g.
  `5Z7KSqKVBFUsAX5gGLPnwk7GTS37dvG1daHVtNvaM2NAZ1zXqRb3VFJYWStofAY121kkyForPHhrxb4y68TEunZ1`,
  a real Solana signature shape, confirmed live via
  `GET /api/wallets/9bBq6R2yJvvM8uEYmsb3KJZSKy3pqatbTLbQvpNsTD2t`.
- `docs/jupiter-prediction-discovery.md` §4 documents (from Jupiter's own
  dev guide) that every fill goes through a keeper-matched, three-transaction
  on-chain flow, and that `/history` rows carry both `signature` and
  `slot` for exactly this reason — cross-checkable against
  `getTransaction` if ever needed.
- **Caveat**: the `trades` table itself (what `/api/trades/recent` and
  `/api/trades/stream` serve) has **no `transaction_signature` column at
  all** — only `history_events` does, and that's only populated for a
  handful of wallets (§4). So the live feed's rows are real trades, but
  not independently verifiable on-chain *from the live-feed data alone*.

**Do the fields look real?** Yes. Trade IDs are sequential Jupiter order
IDs (`order-2408705` through `order-2408811`, a tight, plausible
increment over a 9-minute window). `ownerPubkey` values are well-formed
Solana base58 pubkeys. `amountUsd`/`priceUsd` are plausible decimal USD
values with prices in the expected $0.01–$0.99 binary-market range.
`eventTitle`/`marketTitle` are real-world events ("2026 FIFA World Cup:
Top Goalscorer," "Bitcoin Up or Down — July 6, 7:00PM–7:15PM ET," "United
States vs. Belgium"). Nothing about the shape or content looks
synthetic or placeholder.

**Known hard limitation of this endpoint itself (not our bug)**:
`001_init.sql`'s own migration comment and `docs/rest-api-capabilities.md`
§3.5 both document that `/trades` has **no pagination, ever**, and
structurally holds only **~20 rows spanning ~7 minutes**, regardless of
how it's polled. This is why the bootstrap run captured exactly 20 rows —
that's the entire window the endpoint exposes at any single call, not a
truncation of something larger.

---

## 4. Wallet quality audit

Two disjoint wallet populations exist in production right now, and
almost never overlap:

### Population A — the 18 wallets seen in `trades` (live-feed wallets)

Every wallet scored via `GET /api/scores/latest?limit=25` (25 candidate
wallets total — the 18 from `trades` plus 7 more from another candidate
source with zero trade data):

| Trades per wallet | Count of wallets |
|---|---|
| 1 trade | 15 |
| 2 trades | 3 |
| 0 trades (candidate only, no data) | 7 |

- **Every single scored wallet has ≤2 trades and exactly 1 active day.**
  Zero wallets have enough sample to exit the "weak" tier.
- Tier distribution: **18 "weak", 7 "unknown" (zero trades) — 0 "watch",
  0 "strong", 0 "elite".**
- Score explanations are self-aware and honest about this: e.g. wallet
  `8yYw5fKLpb...` — score 3/100, tier "weak" — *"Sample-size penalty
  applied: 1 trade(s) is below the 30-trade confidence threshold (x0.03
  multiplier on the final score)."* Wallet `8jqFQXuE5p...` (Jupiter's own
  #1 all-time wallet, see below) — score 0, *"No trades ingested for this
  wallet yet — score and tier are not meaningful, treat as unknown."*
- Several wallets show large **negative** realized PnL from a single
  trade — e.g. one wallet shows **-$214.50 PnL on a $20.83 volume, 1
  trade** — meaningless as a signal at n=1, and exactly the kind of
  reading Smart Score's own sample-size gate is designed to suppress
  (successfully, in this case — it's still scored 0/"weak", not treated
  as "smart").
- History/position depth: even among wallets that *did* get bootstrap
  history/position ingestion (only the "5 most recently active" at
  deploy time), depth is thin — one sampled wallet
  (`9bBq6R2yJv...`) has 2 positions and 10 history rows total, 1 trade.
  `positions.lifecycle_status` was observed `null` on a real sampled
  position (schema supports `open`/`resolving`/`settled`, but it isn't
  reliably populated in the data actually ingested).

### Population B — Jupiter's own all-time leaderboard (`GET /api/leaderboards/latest?period=all_time`)

This is real, rich, Jupiter-computed aggregate data — e.g. rank #1:
$211,905.81 realized PnL, $751k+ lifetime volume, 75 predictions, 26.67%
win rate. This is a genuinely meaningful "who has historically performed
well" signal, sourced from Jupiter itself, not derived from our sparse
trade capture.

**But**: querying `GET /api/wallets/8jqFQXuE5pQ15bhMY6399CqHgYpnEUYkzkZZPdf3w4fB`
(that exact #1 wallet) returns **`recentTrades: 0`, `recentHistory: 0`,
`positions: 0`**, and the same "no trades ingested... treat as unknown"
Smart Score explanation. **We know this wallet is good by Jupiter's own
number, but have zero trade-level detail on how, when, or on what markets
it got there.** This is true of essentially every leaderboard wallet —
our one 9-minute trade capture was never going to coincide with the
platform's specific top performers by chance.

**Flagged as fake-looking / statistically unreliable:**
- Leaderboard rank #4: **$55,388 realized PnL on only $712.57 volume and
  3 predictions** — an implausible ROI-to-volume ratio for 3 trades;
  worth scrutiny before trusting, not necessarily wrong, but not
  something to build confidence on without more history.
- Any of the 15 single-trade wallets with large negative or positive PnL
  swings (multiple examples above) — one trade is not a track record.

**Conclusion: no, the wallets in this system are not currently
meaningful** in the "worth copying" sense. Either the sample size is 1
trade (Population A) or the sample size for *trade-level* data is 0
(Population B, despite a real aggregate PnL number).

---

## 5. Copy-trading feasibility audit

| Requirement | Verdict | Evidence |
|---|---|---|
| Entry time | **YES** | `trades.upstream_timestamp` / `history_events.upstream_timestamp` present and accurate wherever a row exists. |
| Side YES/NO | **YES** | `trades.side` / `history_events.side` present. |
| marketId | **YES** | Present on every trade/history/position row. |
| Amount | **PARTIAL** | Present on `trades.amount_usd`; some `history_events` rows for non-fill event types showed `amountUsd: "0.000000"` (event-type-dependent, per the API's 14-value `eventType` enum) — not uniformly populated across all row types. |
| Price | **PARTIAL** | Same caveat as amount — present on trades, inconsistent on some history event types. |
| Wallet | **YES** | `ownerPubkey` present everywhere. |
| Exit/settlement data | **PARTIAL** | `positions` has `settlement_date`, `payout_usd`, `claimed`, `claimable` — real fields with real values when present — but only ingested for a handful of wallets (bootstrap N=5), frozen at deploy time, never updated since. |
| Realized PnL | **PARTIAL** | Present at position/history/profile level, but computed from the same tiny, frozen sample; no independent per-trade PnL reconciliation. |
| Position state | **NO** (in practice) | `lifecycle_status` column exists (`open`/`resolving`/`settled`) but was observed `null` on a real, currently-sampled position row — not reliably populated, and never refreshed after ingestion. |
| Transaction signature or equivalent | **PARTIAL** | Present and real on `history_events.transaction_signature` — **absent entirely** from the `trades` table/schema (no such column), so the live feed itself has no on-chain proof attached. |
| Enough history depth | **NO** | Entire `trades` table = 20 rows, ever, covering one 9-minute window from 2026-07-06. `history_events`/`positions` limited to ~5 wallets' first page each (`/history` has no pagination traversal — confirmed elsewhere in this same codebase's own docs that one wallet has 8,421 total history events against ~8-10 actually fetched). |

**Can we simulate copying a wallet using current data? No.** Most of the
individual *fields* needed technically exist somewhere in the schema —
this is not primarily a missing-column problem. It's that (a) there is
no continuously-updating data at all right now, (b) the one dataset that
exists is a single 9-minute, 20-trade slice with 1-2 trades per wallet,
(c) exit/settlement/position-state data is thin, stale, and unreliably
populated even where it exists, and (d) the wallets we'd most want to
copy (Jupiter's own top-PnL leaderboard) have zero trade-level detail in
this database at all.

---

## 6. Gaps to close before copy-trading simulation is possible

In rough priority order:

1. **Continuous ingestion** (the #1 blocker). Nothing else below matters
   until this exists. `docs/mvp-status.md` already scopes this as
   "Scheduled ingestion" — the project's own next-phase item #3, not
   started. The 24.4h validation run (`docs/rest-api-validation.md`)
   already proved 15s polling of `/trades` is safe and reliable
   (4.25 trades/min average, 0 permanent data loss over a full day) — the
   validation work to justify this exists; only the always-on scheduler
   itself is missing.
2. **Full paginated `/history` traversal**, not just a first-page sample
   per wallet — needed for real entry/exit reconstruction per wallet,
   not just "recent activity."
3. **Reliable exits / position lifecycle** — `lifecycle_status` needs to
   be consistently populated and kept current (requires #1), not just
   present in the schema.
4. **Broader wallet coverage** — today, history/positions/profiles exist
   for a tiny, arbitrarily-chosen sample (bootstrap N=5 "recently
   active" + top-20 all-time leaderboard), with almost no overlap between
   "wallets we have trade detail for" and "wallets with a real track
   record." Copy-trading needs both at once for the same wallet.
5. **Market resolution data** — confirm `markets.status`/`result` gets
   populated and kept current per market (also blocked on #1), needed to
   know whether a copied position actually won or lost.
6. **Price history** — no time-series price table exists; only a
   point-in-time `avg_price_usd`/`mark_price_usd` on positions. Slippage/
   entry-quality analysis for a copy strategy needs a price history, not
   a single snapshot.
7. **Slippage / liquidity data** — not ingested at all currently
   (`/orderbook/{marketId}` exists upstream per
   `docs/jupiter-prediction-discovery.md` but nothing in this project
   ingests it yet).
8. **Normalized event types** — `history_events`' 14-value `eventType`
   enum has inconsistent field population per type (see amount/price
   caveat above); a copy-trading engine needs a clean, uniform "this was
   a buy fill with these exact terms" event, not a raw upstream dump.

---

## 7. What must be fixed before Smart Score can be trusted

Smart Score's *formula* is not the problem — it is behaving exactly as
designed: every wallet in production today is correctly suppressed to
"weak"/"unknown" because every wallet has 1-2 trades, and the scoring
code explicitly penalizes sub-30-trade samples. The problem is entirely
upstream of scoring:

- With only 20 trades ever ingested, **no wallet can ever reach a
  meaningful sample size** under the current data pipeline, no matter
  how good the formula is.
- Smart Score can only be computed against wallets present in `trades`/
  `positions` — but the wallets with a genuinely good track record
  (Jupiter's own leaderboard) aren't in those tables at all, so Smart
  Score has literally never been computed against Jupiter's actual best
  traders.
- **Fix continuous ingestion first** (§6.1). Once trades accumulate over
  days/weeks per wallet, Smart Score's existing sample-size gating should
  start producing genuinely differentiated scores without needing a
  formula change — this audit found no evidence the scoring logic itself
  needs to change, only that it's starved of data.

---

## 8. Recommended next engineering phase

**Scheduled, always-on ingestion** — before anything else (new pages,
copy-trading, autobuy, or further scoring work). Concretely:

1. Stand up a persistent poller for `/trades` at the already-validated
   15s cadence (no new research needed — `docs/rest-api-validation.md`
   already proved this cadence is safe and lossless over 24.4h).
2. Extend `/history`/`/positions` ingestion beyond the current N=5
   "recently active" sample toward full pagination, at least for wallets
   that also appear on the all-time leaderboard.
3. Re-run `analytics:scores`/`analytics:signals:persist` on a recurring
   schedule tied to the now-continuous ingestion, so Smart Score has a
   chance to reflect more than one frozen snapshot.
4. Only after a real multi-day trade history exists per wallet: revisit
   copy-trading feasibility from scratch using this same checklist (§5).

The legal/ToS question flagged back in Phase 1
(`docs/mvp-status.md` "Known risks") — whether a public wallet-tracking
product is even permitted under Jupiter's SDK & API License Agreement —
remains unresolved and is outside this audit's scope, but is worth
surfacing again here since continuous ingestion is exactly the kind of
"real, ongoing" usage that question was raised about.

---

## Summary (as requested)

- **Latest trade age:** ~14.9 hours as of this audit, and increasing —
  frozen since the one-time deployment bootstrap.
- **Is ingestion continuous?** **No.** Confirmed via PM2, cron, systemd,
  running processes, the data's own timestamps, and the project's own
  README/monitoring docs, which state this gap explicitly.
- **Is the live feed genuinely live?** **No.** The SSE transport works;
  there is nothing new for it to send.
- **Is copy-trading simulation possible now?** **No.** Not a schema
  problem primarily — a data-volume, data-freshness, and
  wallet-coverage-overlap problem.
- **Top blockers:** (1) no continuous ingestion at all, (2) entire
  `trades` table is 20 rows/one 9-minute window, ever, (3) the wallets
  with a real track record (leaderboard) have zero trade-level detail,
  and vice versa, (4) position lifecycle/settlement data is thin and not
  reliably populated even where it exists.
- **Recommended next step:** build and deploy scheduled/always-on
  ingestion (already-validated 15s `/trades` cadence, plus broader
  `/history`/`/positions` coverage) before any further scoring, UI, or
  copy-trading work.
