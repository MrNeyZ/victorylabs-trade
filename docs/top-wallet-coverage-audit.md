# Top Wallet Coverage Audit — Does `/trades` See the Wallets That Matter?

Phase 6.2. Research/audit only — no code, schema, UI, Smart Score,
Trending, or Signals changes. Run against **live production**
(`https://trade.victorylabs.app`, database `vltrade`) at
**2026-07-07, ~14:50-15:00 UTC**, via the read-only HTTP API only (no
direct `psql`). Continuous `/trades` ingestion (`vltrade-trades-poller`,
Phase 6.1) had been running for **~25 minutes** at the time of this audit.

---

## Headline answer

**Top-100-leaderboard coverage in `trades` is 2% (2 of 100), both caught
in the last 25 minutes, both wallets that had only just started trading
in that window. Zero of the top 50 wallets by all-time PnL have ever
appeared — including the single most active wallet on the leaderboard
(1,120 lifetime predictions).** This is not an ingestion bug: continuous
polling is healthy, growing the trades table steadily, and demonstrably
*can* catch a leaderboard wallet the moment it trades (both matches
happened live, during this audit). The problem is structural —
`/trades` is a small, global, unscoped rolling window (documented
elsewhere in this project as ~20 rows/~7 minutes,
`docs/rest-api-capabilities.md` §3.5), and most top-100-by-PnL wallets
trade too rarely, relative to total platform volume, for that window to
ever land on them by chance in any reasonable timeframe.

---

## Methodology

- **Leaderboard**: `GET /api/leaderboards/latest?period=all_time&limit=100`
  (the same one-time bootstrap ingestion from initial deployment,
  snapshot timestamp `2026-07-06T23:10:00Z` — leaderboard ingestion is
  still a bounded, manual job, not continuous; see Phase 6.1's own
  docs update on this).
- **Per-wallet trade coverage**: `GET /api/wallets/:walletPubkey` for
  each of the 100 wallets — `stats.totalTrades`/`totalMarkets`/
  `totalVolumeUsd`/`firstTrade`/`lastTrade` are computed from *every*
  row in `trades` for that wallet (`getAllTradesForWallet`, not a capped
  "recent" query — confirmed by reading
  `src/backend/analytics/walletStats/gatherWalletStatsInput.ts`), so
  this is a complete count, not a sample.
- **Weekly leaderboard**: `GET /api/leaderboards/latest?period=weekly&limit=100`,
  used only for the "highest weekly PnL" pick in §6.
- All 100 leaderboard wallets were checked individually; raw results
  retained for this audit (not committed — see note at the end).

---

## 1 & 2. Leaderboard collection + overlap coverage

100 wallets collected (rank, pubkey, realized PnL, win rate, predictions
count, rank — all present for all 100 rows).

| Cohort | n | ≥1 trade | ≥5 trades | ≥10 trades |
|---|---|---|---|---|
| Top 10 | 10 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| Top 25 | 25 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| Top 50 | 50 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| **Top 100** | **100** | **2 (2.0%)** | **0 (0.0%)** | **0 (0.0%)** |

**Coverage: 2%**, and every matched wallet has exactly **1** trade —
none have enough for `>=5`. Both matches are outside the top 50 (ranks
72 and 81).

---

## 3. Detail on the wallets that DO appear

Both of the two matches:

| Field | Wallet 1 | Wallet 2 |
|---|---|---|
| Wallet | `73yTMri4NdZYDScUwit38opgi4ksDxizbn2CK5SxC8J3` | `5tYTBBhDbaKw9eJokNLNjtqm4sKworubxvsBWUgrZpLv` |
| All-time rank | 72 | 81 |
| Weekly rank | — (not in weekly top 100) | **3** |
| Realized PnL (leaderboard) | $4,409.90 | $4,183.00 |
| Win rate (leaderboard) | 0.00% | **81.82%** |
| Predictions count (leaderboard) | 5 | 11 |
| First observed trade (ours) | `2026-07-07T14:36:51Z` | `2026-07-07T14:47:52Z` |
| Latest observed trade (ours) | same (only 1 trade) | same (only 1 trade) |
| Total trades (ours) | 1 | 1 |
| Unique markets (ours) | 1 | 1 |
| Total volume (ours) | $46.70 | $297.01 |
| Active days | 1 | 1 |
| Trades last 24h | 1 | 1 |
| Trades last 7d | 1 | 1 |
| Volume last 24h / 7d | $46.70 / $46.70 | $297.01 / $297.01 |
| Wallet profile ingested? | No (`profile: null`) | No (`profile: null`) |
| Latest Smart Score | `unknown` (n=1, below sample threshold) | `unknown` (n=1, below sample threshold) |

**Both first-observed timestamps fall inside the ~25-minute window this
audit itself ran in** (`vltrade-trades-poller` started ~14:37 UTC per
Phase 6.1's own report). Neither wallet has a `wallet_profiles` row
(that's from the separate, still-bounded `ingest:rankings`/`/profiles`
job, not re-run since initial deploy) — so even for the two wallets we
*do* have live trade data on, we don't have Jupiter's own profile
aggregate cross-referenced against it in this database yet.

---

## 4. Why the other 98 don't appear — evidence, not speculation

Three things can be checked directly from data already in this database
or its own operational timeline; anything beyond that is stated as
genuinely unknown, not guessed at.

**A. Confirmed: the leaderboard snapshot itself predates continuous
ingestion by ~15.5 hours.** The leaderboard was last ingested
`2026-07-06T23:10:00Z` (one-time bootstrap); continuous `/trades`
polling only started `~2026-07-07T14:37Z` (Phase 6.1). Any leaderboard
wallet that traded in that ~15.5-hour gap — a gap that exists purely
because ingestion wasn't running, not because of anything about the
wallet — would be invisible to us by construction, regardless of how
active it actually is. This is a real, dated, structural gap, not a
guess.

**B. Confirmed: most top-100-by-PnL wallets have a very small
*lifetime* trade count on Jupiter's own leaderboard, independent of our
own coverage.** Distribution of `predictionsCount` across the 100:

| | |
|---|---|
| Median | **3** |
| `predictionsCount == 0` | 7 wallets |
| `predictionsCount < 5` | 52 wallets |
| `predictionsCount < 10` | 63 wallets |
| `predictionsCount >= 100` | 7 wallets |

Over half of the top 100 by all-time PnL have made fewer than 5
predictions, ever. A wallet with 1-3 lifetime trades is not "hard to
catch by ingestion" so much as *statistically almost never trading at
all* — no polling cadence fixes that; there may simply be no new trade
to observe for months. (This also explains some of the outsized PnL/
volume ratios noted in the companion `docs/reality-check-copytrading.md`
audit — a handful of large one-off wins, not a trading pattern.)

**C. Confirmed and the most important finding: this is NOT just a
"low-frequency wallet" story.** The most active wallets on the entire
leaderboard — by *lifetime* trade count, independent of PnL — have
still never appeared:

| Rank | Lifetime predictions | Win rate | Our trades |
|---|---|---|---|
| 7 | **1,120** | 43.84% | **0** |
| 10 | **618** | 77.18% | **0** |
| 3 | **414** | 68.12% | **0** |
| 64 | 330 | — | 0 |
| 95 | 195 | — | 0 |

A wallet with over a thousand lifetime predictions is, on its face, a
prolific trader — yet it hasn't shown up once in either the original
9-minute bootstrap window or ~25 minutes of continuous polling since.
**What this audit genuinely cannot determine from data available here**:
whether these specific wallets are still actively trading *right now*
(Jupiter's leaderboard schema has no "last active" field, and this
project doesn't ingest `/profiles/{pubkey}/pnl-history`, which is the
one upstream endpoint that could answer this) versus having accumulated
that history over a long period and gone dormant. Both are plausible;
neither is confirmed here. What IS confirmed: even a wallet that trades
often relative to *itself* is still a vanishingly small fraction of
*platform-wide* trade volume, and `/trades` samples platform-wide
activity, not any specific wallet's — see §7.

**D. Not a feed-coverage/parsing issue.** The two wallets that *did*
match prove the pipeline itself (fetch → normalize → upsert → serve)
works correctly end-to-end for a leaderboard wallet the moment it
trades. There's no evidence of a systematic parsing/matching bug — the
gap is about which wallets show up in the global feed at all, not about
losing/misparsing ones that do.

---

## 5. Overlap statistics (summary)

```
Top 10:   0/10   (0%)
Top 25:   0/25   (0%)
Top 50:   0/50   (0%)
Top 100:  2/100  (2%)

Coverage: 2%
```

---

## 6. Ten interesting wallets

| Wallet | Category | Verdict | Why |
|---|---|---|---|
| `5tYTBBhDbaKw9eJokNLNjtqm4sKworubxvsBWUgrZpLv` (all-time #81, weekly #3) | Highest weekly PnL / real match | **GOOD** | The one standout in this entire audit: appears on *both* leaderboards, 81.82% win rate over 11 predictions, and we have a real, freshly-captured live trade for it. Small sample (n=1 in our DB) but the only wallet here with any live signal at all. |
| `73yTMri4NdZYDScUwit38opgi4ksDxizbn2CK5SxC8J3` (all-time #72) | Real match | **IGNORE** | We caught a trade, but 0.00% win rate on the leaderboard and only 5 lifetime predictions — matching by luck doesn't make it a good copy candidate. |
| `Fvii2smVnFpRBYZaoTky7QYwB7q3i4pySWXX5Bg6zSyq` (all-time #4) | Highest ROI (7,773%) | **IGNORE** | $55,388 PnL on just $712 volume, 3 lifetime predictions — an implausible ROI-to-sample ratio (already flagged in `docs/reality-check-copytrading.md` §4 as statistically unreliable). Zero trades in our DB. |
| `38wm4WBBBYWQ...` (all-time #8) | 2nd-highest ROI (7,574%) | **IGNORE** | Same pattern — 5 predictions, tiny volume, outsized PnL. Not a repeatable strategy to copy from this little data. |
| `2xGcfVFjqVeJ...` (weekly #1) | Highest weekly PnL | **IGNORE** | $21,932 weekly PnL but `predictionsCount: 0` on the leaderboard itself — the PnL number exists with no recorded predictions behind it, the same "real dollar figure, no trading activity to explain it" pattern flagged before. Not something to copy; nothing to copy *from*. |
| `CsDziMuu2sjy...` (all-time #13) | Highest win rate (100%, n=8) | **WATCH** | Perfect win rate, but n=8 is still thin (per this project's own Smart Score threshold, real confidence starts at 30). Worth watching if it ever surfaces in the live feed; not enough to act on yet. |
| `E2LVpNdLeNpv...` (all-time #19) | 2nd-highest win rate (100%, n=15) | **WATCH** | Same reasoning, slightly larger sample. Still well under a meaningful confidence threshold. |
| `FGChAFYEFJ9y...` (all-time #7) | Most active (1,120 predictions) | **WATCH** | Huge lifetime sample size — if this wallet is still active, it's exactly the kind of wallet Smart Score's sample-size gating was built for. But 43.84% win rate is below breakeven-looking, and it has zero live trades in our DB, so there's nothing to score yet. |
| `3NTVKemfaucz...` (all-time #10) | 2nd-most active (618 predictions), strong win rate (77.18%) | **WATCH** | The best *profile* in this whole list on paper — large sample, strong win rate — but zero live visibility. This is precisely the wallet class §7 concludes we're structurally unlikely to catch soon via `/trades` alone. |
| `CdzvU3te3u5j...` (all-time #3) | 3rd-most active (414 predictions), $77.6k PnL | **WATCH** | Same reasoning as above — strong on-paper profile, no live data yet. |

---

## 7. The most important question, answered honestly

**Can continuous `/trades` ingestion eventually learn these wallets
naturally if left running? Partially, and far too slowly to rely on for
the wallets that matter most.**

Evidence for "yes, it can, in principle":
- Two leaderboard wallets were caught organically in the ~25 minutes
  this audit itself covers, with no changes to ingestion — direct proof
  the mechanism works and isn't fundamentally blind to leaderboard
  wallets.
- The trades table itself is healthy and growing continuously
  (66 → 84 → 91 rows across three checkpoints ~3-4 minutes apart during
  this audit, ~61 unique wallets and ~65 unique markets observed in the
  current ~93-row window) — this is genuine platform-wide breadth, not
  a stalled or degenerate feed.

Evidence for "not fast enough, and possibly never, for the wallets that
matter most":
- `/trades` is a **global**, unscoped, small rolling window (~20 rows/
  ~7 minutes platform-wide, per this project's own prior validation:
  4.25 trades/min average across *everyone* trading on Jupiter Predict).
  It has no concept of "this specific wallet" — it surfaces whoever
  happens to trade in the last few minutes, platform-wide.
- The wallets worth copying (§6: highest ROI, highest win rate, most
  active by lifetime volume) are, almost by definition, a tiny fraction
  of total platform trade count at any moment — even a wallet with 1,120
  lifetime predictions is competing for visibility against however many
  thousands of other wallets are also trading, in a feed that only ever
  shows the last ~20 trades platform-wide.
- Over half the top 100 (52%) have fewer than 5 lifetime predictions —
  for those, there may be no new trade to catch for weeks or months
  regardless of ingestion uptime.
- The three *most active* wallets on the entire leaderboard (1,120, 618,
  414 lifetime predictions) have **all** still gone uncaught, which is
  the strongest single piece of evidence that this isn't primarily a
  "just wait longer" problem — if raw activity volume alone were
  sufficient, these three would be the most likely to have already
  appeared.

**Conclusion: we are not fundamentally missing a broken feed — we are
missing the ability to specifically watch the wallets we already know
matter.** `/trades` gives platform-wide breadth (many different
wallets, shallow per-wallet data) by construction; it structurally
cannot give guaranteed depth on any *specific* wallet, no matter how
long it runs. Building a copy-trading-grade dataset for the top 100
requires directly polling wallet-scoped endpoints
(`/history?ownerPubkey=X` / `/positions?ownerPubkey=X`, both already
documented as existing and already used — in bounded, one-shot form —
by this project's `ingest:history:recent`/`ingest:positions:recent`
jobs) for those *specific* pubkeys, not waiting for the global firehose
to randomly land on them.

---

## Recommended next engineering step

**Do not implement this now — this phase is report-only.** For a future
phase to scope:

1. **Wallet-scoped continuous ingestion for a known watchlist** — extend
   the same "one source of truth, run forever" pattern Phase 6.1 built
   for `/trades` to `/history`/`/positions`, but scoped to the top-N
   leaderboard wallets specifically (not the "5 most recently active"
   sample the current bounded jobs use), polled on a slower cadence
   (these are per-wallet calls, not a shared global feed — polling 100
   wallets every 15s is a very different rate-limit shape than polling
   one global endpoint).
2. **Re-run leaderboard ingestion** (`ingest:rankings`) on a schedule —
   it's currently as stale as the original bootstrap (`2026-07-06T23:10Z`),
   so "top 100" itself is already ~16 hours old at the time of this
   audit and only gets staler.
3. Once both of the above exist, re-run this exact audit — the 2%
   figure should be directly comparable and should climb substantially
   if wallet-scoped ingestion is the right fix, which would itself be
   useful confirmation.

---

*Raw per-wallet data collected for this audit (100 leaderboard rows ×
wallet-detail lookups) was not committed to the repository — it's a
point-in-time API pull, not a durable artifact, and this document
already contains every figure derived from it.*
