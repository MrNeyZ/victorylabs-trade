# Market Intelligence API

Phase 4.3. `GET /api/markets/:marketId` is the market-scoped counterpart
to `GET /api/wallets/:walletPubkey` (`docs/wallet-intelligence-api.md`,
Phase 3.4) — everything this project knows about one market, in a single
read-only response, for the market detail page this phase also adds.

This document does not repeat the underlying formulas (Trending Market
Score — see `docs/trending-markets.md`; Smart Score — see
`docs/smart-score.md`) — only how this endpoint assembles and serves
them for one specific market.

---

## 1. Response shape

```jsonc
{
  "marketId": "POLY-2793969-1",
  "eventTitle": "Argentina vs. Egypt",
  "activitySummary": { /* MarketActivitySummary */ },
  "trendingMarket": { /* TrendingMarket, or null */ },
  "recentTrades": [ /* Trade[], most recent first, capped at 50 */ ],
  "topWalletsInMarket": [ /* MarketWalletActivity[], by volume desc, capped at 10 */ ],
  "smartWalletsInMarket": [ /* MarketSmartWallet[], by score desc */ ],
  "whaleSignals": [ /* PersistedSignal[], type=whale_trade, capped at 20 */ ],
  "consensusSignals": [ /* PersistedSignal[], type=market_consensus, capped at 20 */ ],
  "sideBreakdown": { "yes": 3, "no": 1 },
  "volumeBreakdown": { "yes": "142.300000", "no": "7.500000" }
}
```

A syntactically valid `marketId` this project has no trades for is
**not a 404** — same "open identifier space" convention
`GET /api/wallets/:walletPubkey` already documents: it returns 200 with
`eventTitle`/`trendingMarket: null`, `activitySummary` zeroed,
`sideBreakdown`/`volumeBreakdown` zeroed, and every array empty.

## 2. Field definitions

### 2.1 `eventTitle`

The first non-null `trades.event_title` among every trade this project
has ever ingested for this market. `null` if none had one (or the
market has no trades at all).

### 2.2 `activitySummary` — `MarketActivitySummary`

Computed by `computeMarketActivitySummary` (`src/backend/analytics/marketDetail/computeMarketDetail.ts`)
over **every trade this project has ever ingested for this market** (not
windowed) — the market-scoped counterpart to `WalletActivitySummary`
(`docs/wallet-intelligence-api.md` §2.7).

| Field | Type | Notes |
|---|---|---|
| `totalTrades` | `number` | All-time (as far as this project's ingestion goes), not windowed. |
| `totalVolumeUsd` | `string` (decimal) | Sum of `amount_usd` across all trades. |
| `uniqueWallets` | `number` | Distinct `owner_pubkey`s across all trades — all-time, not just the recent window (contrast with `trendingMarket.uniqueWallets`, §2.3, which is windowed). |
| `tradesLast24h` / `tradesLast7d` | `number` | Relative to request time. |
| `volumeLast24h` / `volumeLast7d` | `string` (decimal) | Relative to request time. |
| `firstSeenAt` / `lastSeenAt` | ISO timestamp or `null` | This market's earliest/latest trade this project ever ingested. `null` only when `totalTrades` is `0`. |

### 2.3 `trendingMarket` — reuses Trending Market Score, unmodified

`null` if this market had no activity within the last 1440 minutes (24h
— the same default lookback `/api/trending/markets`/the dashboard use):
it simply wouldn't be a trending candidate right now. When present, it's
the exact same `TrendingMarket` shape `GET /api/trending/markets`
returns (`docs/trending-markets.md` §2), computed by a **new, additive**
gather function
(`gatherTrendingMarketInputForMarket`, `src/backend/analytics/trendingMarkets/gatherTrendingMarketsInput.ts`)
that reuses the exact same repository functions and scoring formula
Trending Market Score already used before this phase — this phase's
brief was explicit that Trending Market Score itself must not change,
and it doesn't; this endpoint only adds a way to compute it for one
market without scanning/ranking the full candidate list.

### 2.4 `recentTrades`

The market's own trades, most-recent-first, capped at 50 — same `Trade`
shape every other endpoint in this project returns.

### 2.5 `topWalletsInMarket` — `MarketWalletActivity[]`

Every distinct wallet that has traded this market (all-time), ranked by
**their own volume in this market**, descending, capped at 10:

| Field | Type |
|---|---|
| `walletPubkey` | `string` |
| `tradeCount` | `number` |
| `volumeUsd` | `string` (decimal) |

Not filtered by Smart Score — this is "who's most active here", not
"who's good here" (that's `smartWalletsInMarket`, §2.6). A wallet can
appear in both, in different positions.

### 2.6 `smartWalletsInMarket` — `MarketSmartWallet[]`

Every distinct trader in this market whose latest Smart Score snapshot
is `>= 35` (the same threshold used everywhere else in this project —
`detectSmartMoneySignals.ts`'s `minSmartScore` default,
`gatherDashboardData.ts`'s `activeSmartWallets`, Trending Market Score's
own `smartParticipation` component), sorted by score descending:

| Field | Type |
|---|---|
| `walletPubkey` | `string` |
| `score` | `number` (0-100) |
| `tier` | `WalletScoreTier` |

A wallet that has never been scored (no `wallet_score_snapshots` row) is
simply absent — not included with a score of `0`.

### 2.7 `whaleSignals` / `consensusSignals`

Persisted signals (`smart_money_signals`, Phase 3.6) filtered to this
market's `market_id` and the respective `type`, capped at 20 each —
reuses `signalsRepository.getRecentSignals({ marketId, type })`
unmodified (that function already supported both filters before this
phase).

### 2.8 `sideBreakdown` / `volumeBreakdown`

Two small, separate objects rather than one nested structure — matching
the literal two fields this phase's brief asked for:

- `sideBreakdown` — trade **count** per side (`{ yes, no }`), all-time.
- `volumeBreakdown` — summed **volume** per side (`{ yes, no }`,
  decimal strings), all-time.

## 3. Data sources

| Table | Used for |
|---|---|
| `trades` | `eventTitle`, `activitySummary`, `recentTrades`, `topWalletsInMarket`, `sideBreakdown`, `volumeBreakdown`, and (via Trending Market Score's own gather function) `trendingMarket` |
| `wallet_score_snapshots` | `smartWalletsInMarket`, and (via Trending Market Score) `trendingMarket`'s `smartWallets` count |
| `smart_money_signals` | `whaleSignals`, `consensusSignals`, and (via Trending Market Score) `trendingMarket`'s `whaleSignalCount`/`consensusSignalCount` |

`positions`/`history_events` are **not** used — none of this endpoint's
required fields need them. Positions/history are wallet-scoped
(`position_pubkey`/`owner_pubkey`-keyed, one row per position or event,
not aggregated per market anywhere in this project's schema), and every
field this endpoint returns is either trade-derived, Smart-Score-derived,
or signal-derived. No Jupiter API calls anywhere in this endpoint; no
database writes.

## 4. Limitations

- **`activitySummary`/`topWalletsInMarket`/`sideBreakdown`/`volumeBreakdown`
  scan every trade this project has ever ingested for this market**, with
  no time bound — for a market with a very long trading history this
  means fetching every row into Node (via `getAllTradesForMarket`) rather
  than aggregating in SQL the way `getTopActiveMarkets`
  (`docs/dashboard-api.md`) or `getMarketActivityWindows`
  (`docs/trending-markets.md`) do. Acceptable at this project's current
  scale; the same tradeoff `docs/wallet-intelligence-api.md` §5 already
  accepts for a single wallet's full trade history.
- **`trendingMarket` can be `null` even for a genuinely active market**
  if `analytics:signals:persist` hasn't run recently enough for the
  signal-count components, or if the market's activity falls just
  outside the fixed 1440-minute lookback this endpoint uses (not
  configurable via a query param on this route).
- **No query params on this endpoint at all** — unlike
  `/api/trending/markets`, there's no `lookbackMinutes`/`limit` to adjust
  what "recent" means for `activitySummary`'s 24h/7d windows, or how many
  `topWalletsInMarket`/`recentTrades`/signals come back (all fixed
  constants: 10, 50, 20).
- **Same ingestion-coverage caveat as everywhere else** in this project:
  every field here is only as complete as what this project's own
  `/trades` poller actually captured for this market — not a census of
  real Jupiter Prediction activity.
- **`smartWalletsInMarket`/`topWalletsInMarket` reflect current state**,
  not "who was smart/active when they actually traded" — a wallet's
  Smart Score may have changed since its trades in this market were
  made.

## 5. Future frontend usage

Already implemented this phase (`/market/[marketId]`, no separate work
needed) — this section is kept for parity with
`docs/wallet-intelligence-api.md` §5/`docs/dashboard-api.md` §6, which
were written before their pages existed. For a future iteration:

- **Charts** — explicitly out of scope this phase; `sideBreakdown`/
  `volumeBreakdown` are natural candidates for a simple pie/bar
  visualization once charts are introduced.
- **Cross-links to the trending-wallets that are also active here** —
  `smartWalletsInMarket` already identifies them; a future pass could
  cross-reference against `/api/trending/wallets` to highlight overlap
  ("3 of this market's smart wallets are also currently trending").
- **A `lookbackMinutes` query param**, mirroring `/api/trending/markets`,
  if a future need arises to see this market's activity summary over a
  window other than the fixed 24h/7d this phase hardcodes.
