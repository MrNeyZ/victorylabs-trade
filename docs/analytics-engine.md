# Analytics Engine

Phase 3.1. The first internal analytics computation in VictoryLabs Trade —
wallet-level statistics derived from our own already-ingested Postgres
data. No new ingestion, no API changes, no UI. This document explains the
architecture, the exact data flow, what each computed metric means (and
which upstream fields it comes from), and where this is expected to grow
next.

---

## 1. Architecture

```
src/backend/analytics/
  walletStats/
    computeWalletStats.ts      — pure function: (rows) -> WalletStats
    gatherWalletStatsInput.ts  — impure I/O: fetches rows from Postgres
    index.ts
  marketStats/                — placeholder, not implemented this phase
  scoring/                     — placeholder, not implemented this phase
```

This follows the same "pure core, impure shell" split already used
throughout the backend (`core/normalize*.ts` are pure; `db/repositories/`
and `ingestion/*.ts` do the I/O):

- **`computeWalletStats.ts`** takes plain, already-fetched arrays/objects
  as arguments and returns a plain object. No database, no HTTP, no
  Express, no `Date.now()`/randomness — the same input always produces
  the same output. This is what requirement 3 ("pure function, no writes,
  no HTTP, no Express") means taken to its logical conclusion: it also
  doesn't *read* the database itself, since a DB read is exactly as much
  of a side effect as a write for purity purposes.
- **`gatherWalletStatsInput.ts`** is the impure half: it calls four
  repository functions in parallel (`Promise.all`) and hands the raw rows
  to the pure function. This is the only file in `analytics/` that
  touches Postgres.
- **`src/backend/jobs/analyticsWallet.ts`** is the CLI entry point
  (`npm run analytics:wallet -- <wallet_pubkey>`) — loads `.env`, calls
  `gatherWalletStatsInput` then `computeWalletStats`, pretty-prints the
  result as JSON, closes the pool. It is the only place in this feature
  that has any process/CLI concerns at all.

No repository query was duplicated to build this: `positionsRepository.getPositionsForWallet`
and `walletProfilesRepository.getWalletProfile` already fetch everything
for one wallet with no limit, and were reused as-is.
`tradesRepository.getRecentTrades`/`historyRepository.getRecentHistoryForWallet`
were designed for the API's "recent N" use case with a small default
limit, so two thin wrappers —
`getAllTradesForWallet`/`getAllHistoryForWallet` — call the *same*
underlying query with a generously large limit instead of writing new SQL.

## 2. Data flow

```
tradesRepository.getAllTradesForWallet(wallet)         ─┐
historyRepository.getAllHistoryForWallet(wallet)        ├─► gatherWalletStatsInput  ─►  computeWalletStats  ─►  WalletStats (JSON)
positionsRepository.getPositionsForWallet(wallet)       │        (Promise.all)             (pure)
walletProfilesRepository.getWalletProfile(wallet)      ─┘
```

Everything above is a read against tables this project already populates
via its existing ingestion jobs (`ingest:trades:*`, `ingest:history:recent`,
`ingest:positions:recent`, `ingest:rankings`) — this phase adds no new
Jupiter API calls anywhere.

## 3. Computed metrics

| Field | Source | Notes |
|---|---|---|
| `totalTrades` | `trades` | `COUNT` of rows for this wallet. |
| `totalMarkets` | `trades` ∪ `positions` ∪ `history_events` | Distinct `marketId`, union of all three (a wallet's markets may show up in one source but not another, since each table is only ever populated for wallets/periods this project happened to poll). |
| `currentOpenPositions` | `positions` | Rows where `pnlUsd !== null`. Jupiter nulls `pnlUsd`/`valueUsd`/`markPriceUsd` once a market closes (documented in `core/normalizePosition.ts`, Phase 2.6) — that transition is the open/closed signal used here, since `lifecycleStatus` is `null` on ordinary (non-Forecast-self-custody) positions and can't be used instead. |
| `closedPositions` | `positions` | Rows where `pnlUsd === null`. **Not a full historical count** — only positions this project has actually fetched `/positions` for; a wallet's positions closed before it was ever polled won't appear here at all. |
| `totalVolumeUsd` | `trades`, fallback `wallet_profiles` | `SUM(trades.amountUsd)` if any trades exist; else `wallet_profiles.totalVolumeUsd`. |
| `realizedPnlUsd` | `history_events`, fallback `wallet_profiles` | `SUM(history_events.realizedPnlUsd)` over non-null rows, if any exist; else `wallet_profiles.realizedPnlUsd`. Deliberately **not** also summed from `positions.realizedPnlUsd` — that would double-count the same underlying settlement fact from a second view of it. |
| `unrealizedPnlUsd` | `positions` only | `SUM(positions.pnlUsd)` over currently-open positions. No `wallet_profiles` equivalent exists at all, so there is no fallback — an empty result is honestly `"0.000000"`, not a missing value. |
| `averageEntryPrice` | `trades` | Average `priceUsd` where `action = 'buy'`. `null` (not `"0"`) if there are no buy trades — a real "no data" distinct from a computed zero. |
| `averageExitPrice` | `trades` | Average `priceUsd` where `action = 'sell'`. Same null-vs-zero distinction. |
| `averageHoldTimeSeconds` | `positions` | Average of `(settlementDate ?? updatedAt) - openedAt`, in seconds, over closed positions with both timestamps present. `null` if none qualify. |
| `firstTrade` / `lastTrade` | `trades` | `MIN`/`MAX` of `upstreamTimestamp`. |
| `activeDays` | `trades` | Distinct UTC calendar days (`upstreamTimestamp` truncated to `YYYY-MM-DD`) with ≥1 trade. |
| `usedProfileFallbackFor` | — | Lists which of `totalVolumeUsd`/`realizedPnlUsd` (if either) came from `wallet_profiles` instead of being reconstructed — an explicit, inspectable record of *why* a number is what it is, not just the number itself. |

All money fields are decimal strings (`"113.850669"`, never a `number`),
computed via `sumDecimalStrings`/`averageDecimalStrings`
(`src/backend/utils/decimal.ts`, added this phase) — exact `BigInt`
fixed-point arithmetic scaled to 6 decimals, the same precision upstream
itself uses for micro-USD. `averageDecimalStrings` truncates (does not
round) at the 6th decimal on division — a worst-case error under
$0.000001, immaterial for a display/analytics value that isn't fed back
into further money math.

## 4. Verified behavior (Phase 3.1)

Run against a throwaway local Postgres populated via the full ingestion
workflow (migrate → `ingest:trades:once` → `ingest:history:recent` →
`ingest:positions:recent` → `ingest:rankings`):

- **Reconstruct path**: a wallet with real trades/history/positions but
  no `wallet_profiles` row. Every field was hand-verified against direct
  SQL against the same database (summed `trades.amount_usd`, averaged
  `trades.price_usd` for buys, summed `positions.pnl_usd`) and matched
  the CLI output exactly. `usedProfileFallbackFor` was empty, as expected.
- **Fallback path**: a wallet with a `wallet_profiles` row but zero
  trades/history/positions ingested. `totalVolumeUsd`/`realizedPnlUsd`
  matched the `wallet_profiles` row exactly, `unrealizedPnlUsd` was
  honestly `"0.000000"` (no fallback source exists for it), and
  `usedProfileFallbackFor` correctly listed both fields.
- **Unknown wallet**: zero rows anywhere. Returned all zeros/nulls
  gracefully (no crash, no fallback triggered since there's no profile
  either) — a legitimate, non-error outcome for a query over an open
  identifier space.
- **Missing CLI argument** and **missing `DATABASE_URL`** both fail
  loudly (usage message / thrown error) with a non-zero exit code,
  consistent with every other script in this project.

This project deliberately does not compare these numbers against
Jupiter's own dashboards/UI as a correctness bar — only against our own
raw ingested rows, since the entire point of this engine is computing
from *our* database. Where `wallet_profiles` data is used (the fallback
path), the match is exact by construction, since it's the same value
Jupiter itself already computed and we already stored verbatim — not an
independent cross-check.

## 5. Known limitations (carried over from `docs/mvp-status.md`)

- `closedPositions` reflects only positions this project has actually
  polled for a given wallet, not that wallet's complete history.
- `totalMarkets`/`totalTrades`/etc. are bounded by whatever this project
  has ingested for that wallet — for a wallet never covered by
  `ingest:trades:*`/`ingest:history:recent`/`ingest:positions:recent`,
  every reconstructed field is `0`/`null` unless a `wallet_profiles` row
  happens to exist from a leaderboard-driven ingestion run.
- No caching, no incremental computation — every CLI invocation refetches
  everything for that wallet from scratch. Fine for on-demand, one-wallet
  analysis; would need real consideration before running this across
  every wallet in the database on a schedule.

## 6. Future extensions

- **`marketStats/`** (scaffolded, not implemented): per-market volume,
  activity, and price-movement stats — same pure/impure split.
- **`scoring/`** (scaffolded, not implemented): the actual "is this
  wallet smart money" ranking logic this whole project exists for,
  built on top of `WalletStats` once it's been validated across many
  wallets, not just the few exercised in this phase's verification.
- **Batch computation**: a job that computes `WalletStats` for every
  wallet in `wallets` (or every wallet on a leaderboard) rather than one
  at a time via the CLI, likely persisted to a new table rather than
  recomputed on every read.
- **Wire into the API/frontend**: `computeWalletStats`'s output is a
  natural fit for `GET /api/wallets/:walletPubkey` once there's a reason
  to serve it — deliberately not done in this phase (no API changes was
  an explicit constraint).
