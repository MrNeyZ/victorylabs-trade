# MVP Status

Snapshot as of Phase 2.10. This document is the honest, current-state
counterpart to [`README.md`](../README.md)'s roadmap — it says what's
actually built and running today, not what's planned.

---

## What works now

**Database** (`src/backend/db/migrations/001_init.sql`, `002_history_events.sql`, `003_wallet_score_snapshots.sql`)
- 8 tables: `markets`, `trades`, `wallets`, `wallet_profiles`, `positions`,
  `leaderboard_snapshots`, `ingestion_runs`, `history_events`, plus
  `wallet_score_snapshots` (Phase 3.3).
- Plain-SQL migration runner (`npm run db:migrate`), idempotent,
  tracked in a `schema_migrations` table.
- Money/contract fields are unconstrained `NUMERIC`, never `BIGINT`/`FLOAT`
  — every domain type keeps them as decimal strings end-to-end.

**Jupiter Prediction API client** (`src/backend/services/jupiterPredictionClient.ts`)
- Typed methods: `getTrades`, `getLeaderboards`, `getProfile`, `getHistory`,
  `getPositions`, `getMarket`.
- Reads `x-ratelimit-*` response headers; on a `429` retries up to twice
  (bounded backoff: `retry-after` if present, else `x-ratelimit-reset`,
  else a small fixed delay) and never swallows a final failure.
- No API key registered or required for reads at this volume (see
  `docs/jupiter-prediction-discovery.md` §7.1).

**Ingestion** (`src/backend/ingestion/`, CLI entry points in `src/backend/jobs/`)
- `ingest:trades:once` — one-shot `/trades` fetch → normalize → upsert.
- `ingest:trades:poll` — bounded polling loop (default 15s interval, 5
  iterations, never `--forever` unless explicitly passed), SIGINT/SIGTERM-safe.
- `ingest:history:recent` / `ingest:positions:recent` — bounded, per-wallet
  `/history` / `/positions` ingestion for the N most recently active
  wallets (from the `trades` table), default N=5.
- `ingest:rankings` — ingests all 3 leaderboard periods once, then
  `/profiles` for the top N all-time wallets (default 20).
- Every run writes one row to `ingestion_runs` (success or error, never
  silently dropped).
- All upserts follow one of two rules: **immutable facts**
  (`trades`, `history_events`, `leaderboard_snapshots`) are
  `ON CONFLICT DO NOTHING`; **mutable latest-state**
  (`wallet_profiles`, `positions`) are `ON CONFLICT DO UPDATE`.

**Backend API** (`src/backend/api/`, `npm run backend:dev`, port 4100 by default)
- `GET /health` — real `SELECT 1` DB check, uptime.
- `GET /api/trades/recent` — filterable (`marketId`, `ownerPubkey`),
  `limit` (default 50, max 200).
- `GET /api/trades/stream` — SSE: snapshot on connect, new-trade events
  every 5s poll, heartbeat every 25s, clean disconnect handling.
- `GET /api/wallets/:walletPubkey` — profile + positions + recent trades
  + recent history in one call.
- `GET /api/leaderboards/latest` — most recent ingested snapshot bucket
  for a period (`all_time` default, `weekly`, `monthly`).
- `GET /api/scores/latest` — most recent persisted Smart Score snapshot
  bucket, filterable by `tier`/`minScore` (Phase 3.3).
- Read-only: never calls Jupiter, never triggers ingestion. CORS is
  wide open (no auth anywhere in this project yet).

**Smart Score** (`src/backend/analytics/scoring/`, `docs/smart-score.md`)
- `computeWalletScore` — conservative 0-100 ranking heuristic, gated on
  sample size and realized losses (Phase 3.2).
- `npm run analytics:scores` (Phase 3.3) persists a snapshot per
  candidate wallet into `wallet_score_snapshots`, bucketed to 5 minutes
  and idempotent within a bucket; served via `/api/scores/latest` and
  `/api/wallets/:walletPubkey`'s `latestSmartScore` field.

**Frontend** (`src/frontend/`, Next.js App Router, `npm run frontend:dev`)
- One page: a live trade feed consuming `/api/trades/stream` directly
  (no proxy). Connection-status badge, snapshot + live-append, capped at
  200 rows in memory. Minimal dark styling, no component library.

---

## What is still missing

- **Only one frontend page.** The backend already supports wallet detail
  and leaderboard data (`/api/wallets/:walletPubkey`,
  `/api/leaderboards/latest`) but no frontend page renders either yet.
- **Smart Score has no frontend page.** `computeWalletScore` and its
  persisted history (`/api/scores/latest`, `latestSmartScore` on
  `/api/wallets/:walletPubkey`) exist, but no UI renders either yet —
  same gap as leaderboard/wallet-detail pages above.
- **No scheduled/always-on ingestion.** Every ingestion job is a bounded,
  manually-invoked run (or a bounded poll with a hard iteration cap). There
  is no cron, systemd timer, or in-repo scheduler keeping the database
  continuously fresh — recency depends entirely on whoever last ran a job.
- **No `/history` pagination traversal.** Each wallet ingestion fetches
  only the first page (confirmed live: `paginationTotal` often far exceeds
  what's fetched — e.g. one wallet showed 8,421 total history events
  against ~8-10 fetched per call). Fine for a live "recent activity" view,
  not for a complete historical record.
- **No registered API key, no auth, no rate-limit headroom.** Reads work
  keyless at low volume; any real, continuously-running deployment needs a
  key (see roadmap) and some form of access control in front of the API
  server, neither of which exist.
- **No automated tests.** Every verification in this project so far has
  been manual (throwaway Postgres + real API calls + curl/Playwright),
  documented in each phase's commit message — there is no test suite that
  runs on its own.
- **No deployment.** Everything in this repo runs locally, on demand,
  in a foreground terminal. No Docker, no PM2, no process manager, no CI.

---

## Known risks

- **Legal/ToS risk is unresolved.** Jupiter's SDK & API License Agreement
  (`docs/jupiter-prediction-discovery.md` §7.6) has clauses that plausibly
  restrict redistributing API content to third parties and combining it
  with independently-scraped data. This was flagged as the **top blocker**
  before any real product ships, back in Phase 1, and nothing since has
  resolved it — it still applies to everything built in Phases 2.1-2.9.
- **`/trades` has no pagination** (`docs/rest-api-capabilities.md` §3.5).
  The Phase 1.9 24.4h validation found 0 non-trivial full-window turnovers
  at observed volume, but a genuine traffic spike could still silently
  drop trades between polls with no way to recover them after the fact.
- **Beta API, breaking-change risk.** Two real inaccuracies were already
  found and fixed by re-probing live data instead of trusting the
  original OpenAPI-spec-derived types (`realizedPnl` nullability and a
  missing `eventMetadata` field on `/history` rows, Phase 2.4) — the API
  can and does drift from what's documented.
- **Ingestion coverage is a sample, not a census.** `/history`,
  `/positions`, and `/profiles` are only ever ingested for whichever
  wallets happen to be "recently active" in `trades` or "top N" on the
  leaderboard — most wallets that have ever traded on the platform have
  no profile/position/history data in this database at all.
- **CORS is wide open and there's no auth.** Fine for local development;
  actively unsafe to expose this API server to the public internet as-is.
- **Single process, no HA.** One Postgres instance, one backend process,
  no replication, no failover — acceptable for local MVP development,
  not for anything resembling production.

---

## Next phases (not started)

1. **Resolve the legal question** (carried over from Phase 1, still the
   top blocker) — get a direct answer from Jupiter on whether a public
   wallet-tracking/leaderboard product is permitted under the SDK & API
   License Agreement, before doing anything with real users.
2. **Register a real API key** once the above clears, and re-validate the
   documented rate limits (`docs/rest-api-capabilities.md` §4) at the
   Developer tier instead of keyless.
3. **Scheduled ingestion** — replace manual/bounded job invocations with
   something that keeps running (a cron-style scheduler, still no
   PM2/Docker per this project's standing constraints) so the database
   stays fresh without a human re-running commands.
4. **Wallet + leaderboard frontend pages**, consuming the endpoints that
   already exist (`/api/wallets/:walletPubkey`, `/api/leaderboards/latest`)
   but have no UI yet.
5. **Smart-money scoring** — the actual "is this wallet worth watching"
   logic this whole project exists for; not started, deliberately deferred
   until the ingestion pipeline above is trustworthy and continuously
   running.
6. **`/history` pagination traversal** for wallets worth a complete
   record, once it's clear which wallets need it.
7. **Hardening**: automated tests, an actual deployment story, auth in
   front of the API — all explicitly out of scope until the product
   direction (and the legal question in #1) is settled.
