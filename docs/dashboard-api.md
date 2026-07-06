# Smart Money Dashboard API

Phase 3.7. `GET /api/dashboard` is a single response that combines
everything the analytics phases before it computed and persisted — Smart
Score (Phase 3.2/3.3), Smart Money Signals (Phase 3.5/3.6), and raw trade
activity (Phase 2) — into the six sections a dashboard page needs, in one
round trip.

This document does not repeat the underlying formulas/detection logic
(`docs/smart-score.md`, `docs/smart-money-signals.md`) — only how this
endpoint assembles and serves them.

---

## 1. Response shape

```jsonc
{
  "generatedAt": "2026-07-06T21:00:00.000Z",
  "lookbackMinutes": 1440,
  "signals": [ /* PersistedSignal[], latest first, any type */ ],
  "topWallets": [ /* WalletScoreSnapshotResult[], score desc */ ],
  "whaleTrades": [ /* PersistedSignal[], type=whale_trade only */ ],
  "consensus": [ /* PersistedSignal[], type=market_consensus only */ ],
  "topMarkets": [ /* TopActiveMarket[], volume desc */ ],
  "activeSmartWallets": [ /* WalletScoreSnapshotResult[], score desc */ ]
}
```

## 2. Field definitions

### 2.1 `generatedAt` / `lookbackMinutes`

- **`generatedAt`** — when this response was computed (server wall-clock
  at request time). This endpoint is computed fresh on every request
  (like `/api/signals/recent?source=live`), not cached — `generatedAt` is
  purely informational, not a cache key.
- **`lookbackMinutes`** — the resolved (clamped) value actually used;
  echoes the query param back so a client can tell if its requested value
  was clamped to the max (see §4).

### 2.2 `signals` — latest persisted signals, any type

`signalsRepository.getRecentSignals({ lookbackMinutes, limit })` — the
same read path `GET /api/signals/recent?source=persisted` uses, no type
filter. Ordered by `occurredAt` descending. See
`docs/smart-money-signals.md` §3 for the full `PersistedSignal` shape
(`id`, `type`, `severity`, `walletPubkeys`, `marketId`, `side`,
`eventTitle`, `amountUsd`, `scoreContext`, `occurredAt`, `explanation`).

### 2.3 `topWallets` — top Smart Score wallets

`walletScoresRepository.getLatestWalletScores({ limit }).rows` — the
exact same data `GET /api/scores/latest` serves: every wallet in the most
recent `analytics:scores` snapshot bucket, ordered by `score` descending.
Not filtered by recent trading activity — this is the global leaderboard,
regardless of whether a top wallet has traded today (contrast with
`activeSmartWallets`, §2.6).

### 2.4 `whaleTrades` — recent whale-trade signals

`getRecentSignals({ lookbackMinutes, limit, type: 'whale_trade' })` — the
same table as `signals`, filtered to one type. These are **persisted**
signals (from whenever `analytics:signals:persist` last ran with
whatever `whaleUsd` threshold it used), not a live re-scan of `trades`
against a threshold computed on this request.

### 2.5 `consensus` — recent market-consensus signals

`getRecentSignals({ lookbackMinutes, limit, type: 'market_consensus' })`
— same as above, filtered to `market_consensus` instead.

### 2.6 `topMarkets` — top active markets

New this phase: `tradesRepository.getTopActiveMarkets(lookbackMinutes,
limit)`. Aggregates `trades` (not signals) within the lookback window,
grouped by `market_id`, ranked by summed `amount_usd` descending:

| Field | Type | Notes |
|---|---|---|
| `marketId` | `string` | |
| `eventTitle` | `string \| null` | Most recent non-null `trades.event_title` seen for this market in the window. |
| `tradeCount` | `number` | Count of trades in this market within the window. |
| `volumeUsd` | `string` (decimal) | Sum of `amount_usd` for this market within the window — computed in SQL over Postgres' arbitrary-precision `NUMERIC`, not fetched row-by-row and summed in JS (see the function's doc comment for why that's still precision-safe). |
| `lastTradeAt` | ISO timestamp | Most recent `upstream_timestamp` in this market within the window. |

Ranked by volume, not trade count — a market with fewer, larger trades
can outrank one with many small ones, matching how this project's Smart
Score already treats volume as the primary activity signal
(`docs/smart-score.md` §2.1).

### 2.7 `activeSmartWallets` — recently active smart wallets

The one section that isn't a single repository call — it composes two
existing ones (no new SQL):

1. `tradesRepository.getRecentActiveWallets({ sinceMinutes:
   lookbackMinutes, limit: 500 })` — distinct wallets with a trade in the
   window (this function already existed, from Phase 2's reconciliation
   work; it filters on `observed_at`, this project's ingestion
   wall-clock, not `upstream_timestamp` — see its own doc comment).
2. `walletScoresRepository.getLatestScoresForWallets(...)` on that
   candidate list — each wallet's own latest score, independent of
   snapshot bucket (same function `gatherSignalDetectionInput.ts` uses).

The results are filtered to `score >= 35` (the same default
`minSmartScore` `smart_wallet_trade` uses — "smart" means the same thing
here as everywhere else in this project), sorted by score descending, and
capped at `limit`. The 500-wallet candidate pool is deliberately larger
than `limit`: most recently-active wallets won't clear the score bar, so
narrowing from a small pool first could return fewer results than
requested even when better candidates exist further back in the trade
window.

**This is the "smart money moving right now" view** — contrast with
`topWallets` (§2.3), which is the global leaderboard regardless of
today's activity.

## 3. Data sources

| Table | Used for |
|---|---|
| `smart_money_signals` | `signals`, `whaleTrades`, `consensus` |
| `wallet_score_snapshots` | `topWallets`, `activeSmartWallets` |
| `trades` | `topMarkets`, `activeSmartWallets` (candidate wallet list) |

`positions`/`history_events` are **not** used by this endpoint — none of
the six sections above needed them. (The phase brief allowed for "where
needed"; this phase's dashboard sections turned out not to need either.)
No Jupiter API calls anywhere in this endpoint; no database writes.

## 4. Query params

| Param | Default | Max | Notes |
|---|---|---|---|
| `lookbackMinutes` | 1440 (24h) | 10080 (7 days) | Applies to `signals`, `whaleTrades`, `consensus`, `topMarkets`, and the candidate window for `activeSmartWallets`. Does **not** affect `topWallets` (always the latest snapshot bucket, regardless of window). |
| `limit` | 20 | 100 | Applied independently to each section — e.g. `limit=20` can return up to 20 `signals` AND up to 20 `topWallets` AND up to 20 `topMarkets`, not 20 total across the whole response. |

Both params reuse `parseLimitParam` (`src/backend/api/queryParams.ts`) —
absent is fine (falls back to default), present-but-invalid (non-integer,
non-positive) is a `400`, present-but-over-max is silently clamped, not
rejected.

## 5. Limitations

- **Computed fresh on every request, not cached.** Six repository calls
  (plus one dependent follow-up for `activeSmartWallets`) run on every
  hit to this endpoint. Fine for a dashboard a human refreshes
  occasionally; not load-tested for high request volume.
- **`whaleTrades`/`consensus`/`signals` reflect whatever was last
  persisted**, not a live recomputation — same staleness caveat
  `docs/smart-money-signals.md` §5 already documents for
  `source=persisted`. If `analytics:signals:persist` hasn't run recently,
  this dashboard won't show a genuinely new whale trade that happened
  since the last run.
- **`topWallets` ignores `lookbackMinutes` entirely.** It's always "the
  latest scored snapshot", which itself is only as fresh as the last
  `analytics:scores` run — there is no historical "top wallets as of N
  minutes ago" view.
- **`activeSmartWallets` can under-return** if fewer than `limit` wallets
  in the 500-candidate pool clear the score bar — this is expected
  behavior (not every recently active wallet is a smart one), not a bug,
  but it means this section's length isn't a reliable proxy for "how much
  smart money is active right now" without also checking whether it hit
  the cap.
- **No per-section pagination/cursor.** `limit` caps each section but
  there's no `offset`/cursor to page further into any of them — same
  constraint every other list endpoint in this project has.
- **Same ingestion-coverage caveat as everywhere else** in this project:
  every section is only as complete as what this project's own polling
  jobs have actually ingested — not a census of real Jupiter Prediction
  activity.

## 6. Future frontend usage

Shaped for a single dashboard landing page, one section per response
field:

- **Header/ticker**: `generatedAt` + a "showing last `lookbackMinutes`"
  label, with a lookback selector (1h/24h/7d) that just changes the query
  param.
- **Signal feed**: `signals` as a scrolling activity feed — `severity` as
  a color/badge, `explanation` as the row text, `occurredAt` for relative
  time ("2m ago").
- **Leaderboard widget**: `topWallets`, same rendering a future
  `/api/scores/latest`-backed leaderboard page would use — this section
  makes it possible to show a compact top-5 slice directly on the
  dashboard without a second request.
- **Whale/consensus call-outs**: `whaleTrades`/`consensus` as two small
  distinct panels — these are the two signal types most likely to warrant
  their own visual treatment (a whale icon; a "N smart wallets agree"
  badge) rather than blending into the general `signals` feed.
- **Hot markets table**: `topMarkets` sorted by volume as-is, with
  `eventTitle` (falling back to `marketId`) as the row label — same
  sortable-table treatment `docs/wallet-intelligence-api.md` §5 already
  proposes for a wallet's `marketBreakdown`.
- **"Smart money right now" strip**: `activeSmartWallets` as a compact
  list/ticker distinct from the `topWallets` leaderboard — this is the
  "who's active today" view, `topWallets` is the "who's good all-time"
  view; a dashboard page benefits from showing both side by side.

None of this is implemented — per this phase's brief, the frontend is out
of scope; this section exists so the next phase that builds the page
doesn't have to re-derive which field maps to which UI element.
