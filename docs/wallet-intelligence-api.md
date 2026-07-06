# Wallet Intelligence API

Phase 3.4. `GET /api/wallets/:walletPubkey` (`src/backend/api/routes/wallets.ts`)
is the single richest read this project offers on one wallet — everything
ingestion (Phase 2) and analytics (Phase 3.1-3.3) know about it, in one
response, for the wallet detail page a future frontend phase will build.
This document is the read-side counterpart to `docs/smart-score.md`
(the scoring formula itself) and `docs/analytics-engine.md`
(`WalletStats`) — it does not repeat either, only how their output is
assembled and served here.

---

## 1. Response shape

```jsonc
{
  "walletPubkey": "string",
  "profile": WalletProfile | null,
  "positions": Position[],
  "recentTrades": Trade[],
  "recentHistory": HistoryEvent[],
  "stats": WalletStats,
  "latestSmartScore": WalletScoreSnapshotResult | null,
  "smartScoreHistory": WalletScoreSnapshotResult[],
  "marketBreakdown": MarketBreakdownEntry[],
  "activitySummary": WalletActivitySummary
}
```

An unknown or never-seen wallet pubkey is **not a 404** — it's a valid
query over an open identifier space this project simply has no data for
yet, same reasoning as every field being nullable/empty rather than the
route erroring. `curl`ing a made-up pubkey returns `200` with
`profile: null`, `latestSmartScore: null`, every array empty, `stats`
zeroed out (`totalTrades: 0`, etc. — see `docs/analytics-engine.md`), and
`activitySummary` fields all `0`/`null`.

## 2. Field definitions

### 2.1 Carried over from earlier phases (unchanged shape)

- **`profile`** — `WalletProfile | null` (`src/backend/types/domain.ts`).
  The latest `wallet_profiles` row (Jupiter's own aggregate PnL/volume),
  or `null` if this wallet has never had `/profiles/{ownerPubkey}`
  ingested for it.
- **`positions`** — `Position[]`. Every ingested position for this
  wallet, latest known state, ordered `updated_at DESC NULLS LAST`.
- **`recentTrades`** — `Trade[]`, most-recent-first by
  `upstreamTimestamp`, capped at 50.
- **`recentHistory`** — `HistoryEvent[]`, most-recent-first by
  `upstreamTimestamp` (nulls last), capped at 50.

As of this phase, `recentTrades`/`recentHistory` are produced by slicing
the **same** full trades/history-events arrays `stats`/`marketBreakdown`/
`activitySummary` are computed from (`gatherWalletStatsInput` — see §3),
not a second, separately-capped query. The ordering `getAllTradesForWallet`/
`getAllHistoryForWallet` already return (delegating to
`getRecentTrades`/`getRecentHistoryForWallet` internally with a very high
limit) is identical to what the old capped queries returned, so this is
not an observable behavior change — just one fetch instead of two.

### 2.2 `stats` — computed `WalletStats` (new in this phase's response, computed since Phase 3.1)

The full `WalletStats` object (`src/backend/analytics/walletStats/computeWalletStats.ts`)
— total trades/markets, realized/unrealized/volume USD, average entry/
exit price and hold time, first/last trade, active days, and which fields
(if any) fell back to `wallet_profiles` because this wallet's own trades/
history were empty. Full field-by-field definitions already live in that
file's doc comments and `docs/analytics-engine.md`; not repeated here.

### 2.3 `latestSmartScore` / `smartScoreHistory` (new in this phase's response, persisted since Phase 3.3)

- **`latestSmartScore`** — the most recent persisted
  `wallet_score_snapshots` row for this wallet (`WalletScoreSnapshotResult`,
  `src/backend/db/repositories/walletScoresRepository.ts`), or `null` if
  `npm run analytics:scores` has never scored this wallet. Equivalent to
  `smartScoreHistory[0]`.
- **`smartScoreHistory`** — every persisted snapshot for this wallet,
  newest first (`getWalletScoreHistory`). Empty array if never scored.

See `docs/smart-score.md` for the scoring formula and §6 there for the
persistence/API layer these two fields read from.

### 2.4 `marketBreakdown` — new in this phase

Per-market activity for this wallet
(`src/backend/analytics/walletStats/computeMarketBreakdown.ts`), one
entry for every market this wallet has a trade, position, or history
event in (the same "which markets" union `WalletStats.totalMarkets`
counts, broken out per market instead of summed to one number). Sorted
by `lastActivityAt` descending (nulls last) — most recently active market
first.

| Field | Type | Notes |
|---|---|---|
| `marketId` | `string` | |
| `eventTitle` | `string \| null` | First non-null `trades.eventTitle` for this market, falling back to `history_events.eventTitle`. `null` if neither has one (e.g. a market only ever seen via a position). |
| `totalTrades` | `number` | Count of this wallet's `trades` rows in this market. |
| `volumeUsd` | `string` (decimal) | Sum of `trades.amountUsd` for this market. `"0.000000"` (never `null`) when this wallet has no trades here — trade volume has no "unknown" state, only zero. |
| `realizedPnlUsd` | `string \| null` | Sum of `history_events.realizedPnlUsd` for this market — same source-of-truth rule as `WalletStats.realizedPnlUsd` (history events, never `positions.realizedPnlUsd`, to avoid double-counting the same settlement). `null` (not `"0.000000"`) if no history event with a non-null realized PnL exists for this market. |
| `currentPositionUsd` | `string \| null` | Sum of `positions.valueUsd` across every position this wallet holds in this market. `null` if no position has been ingested for this market. |
| `lastActivityAt` | `Date \| null` (ISO string over the wire) | Most recent of any trade's `upstreamTimestamp`, any history event's `upstreamTimestamp`, or any position's `updatedAt` (falling back to `openedAt`) in this market. `null` if none of the three have a timestamp. |

### 2.5 `activitySummary` — new in this phase

Recent-activity rollup (`src/backend/analytics/walletStats/computeActivitySummary.ts`).

| Field | Type | Notes |
|---|---|---|
| `tradesLast24h` | `number` | Count of `trades` with `upstreamTimestamp` in the last 24h (relative to when the route ran, not a stored cutoff). |
| `tradesLast7d` | `number` | Same window, 7 days. |
| `volumeLast24h` | `string` (decimal) | Sum of `trades.amountUsd` in the last 24h. `"0.000000"` if none. |
| `volumeLast7d` | `string` (decimal) | Same window, 7 days. |
| `activeMarkets` | `number` | **Identical value to `stats.totalMarkets`** — reused directly, not recomputed, so this and `stats.totalMarkets` can never disagree. |
| `firstSeenAt` | `Date \| null` | Earliest of any trade's `upstreamTimestamp`, any history event's `upstreamTimestamp`, or any position's `openedAt`. Broader than `stats.firstTrade` (trades only) — a wallet with only ingested history/positions and zero trades can still have a `firstSeenAt`. |
| `lastSeenAt` | `Date \| null` | Latest of the same three sources. Broader than `stats.lastTrade` for the same reason. |

## 3. How it's assembled (no new I/O beyond Phase 3.3)

The route makes exactly two calls:

1. `gatherWalletStatsInput(walletPubkey)` — the same function
   `computeWalletStats`/`npm run analytics:wallet`/`analytics:scores`
   already use (`src/backend/analytics/walletStats/gatherWalletStatsInput.ts`):
   fetches all trades, all history events, all positions, and the wallet
   profile, in parallel.
2. `getWalletScoreHistory(walletPubkey)` — the one query specific to this
   route (Phase 3.3's persisted snapshot table).

Everything else — `stats`, `marketBreakdown`, `activitySummary`,
`recentTrades`/`recentHistory` (sliced) — is pure computation over the
result of call #1. No new repository query was added for either new
section; `computeMarketBreakdown`/`computeActivitySummary` are pure
functions over the exact same `ComputeWalletStatsInput` shape
`computeWalletStats` already consumes, and `computeActivitySummary`
takes the already-computed `WalletStats` as an argument specifically so
`activeMarkets` reuses `stats.totalMarkets` instead of re-deriving the
same trades/positions/history-events market union a second time.

## 4. Limitations

- **Same ingestion-coverage caveat as everywhere else in this project**
  (`docs/mvp-status.md`): `marketBreakdown`/`activitySummary` are only as
  complete as whatever trades/history/positions this project has actually
  ingested for this wallet — not a census of the wallet's real on-chain
  activity. A market this wallet traded on Jupiter but that was never
  captured by a poll simply won't appear.
- **`eventTitle` can still be `null`** for a market only ever observed via
  a position (positions carry no `eventTitle` field upstream) with no
  corresponding trade/history row ingested.
- **`realizedPnlUsd`/`currentPositionUsd` being `null` means "no data",
  not "zero".** A market where this wallet definitely has zero realized
  PnL would need at least one history event saying so explicitly; no
  history data at all is indistinguishable here from "never traded here"
  as far as this field goes (the entry still exists in `marketBreakdown`
  via the trades/positions union, just with a `null` PnL).
- **`activitySummary`'s 24h/7d windows are wall-clock-relative to
  request time**, not bucketed/cached — two requests seconds apart around
  a window boundary can disagree by one trade. Same tradeoff this
  project already accepted for `computeWalletScore`'s `recency` component.
- **No pagination on `positions`/`marketBreakdown`.** A wallet active in
  hundreds of markets gets a correspondingly large array back; there is
  no `limit`/`offset` on this route at all (unlike `/api/trades/recent`
  or `/api/scores/latest`).
- **Every array here can be large for a very active wallet** — this
  route now always fetches *all* of a wallet's trades/history (previously
  `recentTrades`/`recentHistory` used their own capped SQL queries; see
  §3). Acceptable for a single-wallet detail page, not for anything that
  fans this out across many wallets at once.

## 5. Future UI usage

This response is shaped for a single wallet-detail page:

- **Header**: `walletPubkey`, `profile` (aggregate PnL/volume Jupiter
  itself computed), `latestSmartScore.score`/`.tier` as the headline
  badge, with `latestSmartScore.explanations` as the "why" tooltip.
- **Score trend**: `smartScoreHistory` plotted over `snapshotAt` — a
  sparkline/line chart of score (and optionally each `components.*`
  sub-score) over time, once `analytics:scores` has run enough times to
  produce more than one bucket.
- **Market table**: `marketBreakdown` rendered as a sortable table
  (`totalTrades`, `volumeUsd`, `realizedPnlUsd`, `currentPositionUsd`,
  `lastActivityAt` are all sortable columns as-is); `eventTitle` (falling
  back to a shortened `marketId`) as the row label.
- **Activity strip**: `activitySummary`'s six fields as small stat
  tiles (24h/7d trade count + volume, active markets, first/last seen)
  above the market table.
- **Raw feeds**: `recentTrades`/`recentHistory`/`positions` as the
  existing detail lists this route already supported before this phase.

None of this is implemented — per this phase's brief, the frontend is out
of scope; this section exists so the next phase that does build the page
doesn't have to re-derive which field maps to which UI element.
