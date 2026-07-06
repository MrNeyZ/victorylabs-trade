# VictoryLabs Trade

Smart Money analytics platform for **Jupiter Prediction** (Solana's on-chain
prediction markets product, `api.jup.ag/prediction/v1`).

Status: **MVP loop working end-to-end, locally.** Postgres schema,
Jupiter ingestion (trades/history/positions/profiles/leaderboards), a
read-only REST + SSE backend, and a minimal live-feed frontend all exist
and have been verified together against real Jupiter data. Nothing is
deployed; there is no scheduler keeping data fresh on its own; no
smart-money scoring exists yet. See [`docs/mvp-status.md`](./docs/mvp-status.md)
for the full, current-state breakdown (what works / what's missing /
known risks), and §6-9 below for how to run it.

---

## 1. Project vision

Jupiter Prediction already computes the hard part of "smart money" tracking
itself — realized PnL, win rate, volume, and a global trade feed — and
exposes it over a documented (beta) REST API. Nobody has to reverse-engineer
on-chain instructions to get this data, unlike most Solana ecosystems.

VictoryLabs Trade's goal is to **turn that already-computed data into a
smart-money tracker**: ingest the platform-wide trade feed and per-wallet
history, identify consistently profitable wallets via Jupiter's own
leaderboard/profile data, and surface their activity as it happens — without
duplicating PnL accounting Jupiter already does correctly.

## 2. Architecture overview

```
Jupiter Prediction REST API (api.jup.ag/prediction/v1)
        │  polling — bounded jobs, no persistent scheduler yet
        ▼
 backend/services    — typed client, x-ratelimit-aware, bounded 429 retry
        ▼
 backend/ingestion    — one-shot + bounded-poll jobs (src/backend/jobs/ = CLI entry points)
        ▼
 backend/core         — pure raw -> domain normalization (decimal strings, never JS number for money)
        ▼
 backend/db           — Postgres, upsert-keyed by upstream id, repositories per table
        ▼
 backend/api          — Express, read-only: JSON routes + one SSE stream
        ▼
 frontend             — Next.js App Router, live trade feed (direct fetch, no proxy)
```

`backend/types` holds two layers deliberately kept apart: `jupiter.ts`
(raw upstream shapes, including its real inconsistencies — e.g. some
count fields are `number` on one endpoint and `string` on another) and
`domain.ts` (this project's normalized model, unit-converted to actual
USD, money always as decimal strings). `shared/` is reserved for anything
both backend and frontend need; the frontend currently only consumes the
backend's JSON/SSE API, not its TypeScript types directly.

This project is **read-only by design**: tracking smart money never
requires signing or submitting a transaction, so there is no wallet,
keypair, or signing capability anywhere in this architecture, and no auth
exists yet either (see limitations, §8).

## 3. Current status

- ✅ Phase 1 research complete (API surface, data model, rate limits, legal
  review) — see [`docs/`](./docs).
- ✅ Phase 1.9: 24.4-hour live REST API reliability validation complete —
  see [`docs/rest-api-validation.md`](./docs/rest-api-validation.md).
- ✅ Phase 2: project skeleton, tooling, Postgres schema, Jupiter client,
  trades/history/positions/leaderboard/profile ingestion, read-only
  backend API + SSE trade stream, minimal live-feed frontend.
- ✅ Phase 2.10 (this phase): local dev orchestration (`npm run dev:*`)
  and this documentation pass.
- ⬜ Phase 3+: not started — smart-money scoring, wallet/leaderboard
  frontend pages, scheduled ingestion, legal resolution. See
  [`docs/mvp-status.md`](./docs/mvp-status.md) for the full list.

## 4. Setup

Requirements: Node.js ≥22, a local PostgreSQL instance you can create a
database in.

```bash
git clone https://github.com/MrNeyZ/victorylabs-trade.git
cd victorylabs-trade
npm install
cp .env.example .env      # then fill in DATABASE_URL at minimum
```

`npm install` installs both the backend (Express, pg, the Jupiter client)
and the frontend (Next.js, React) — this is a single package, not a
monorepo/workspaces setup.

## 5. Environment variables

All in `.env.example`; copy it to `.env` and fill in what you need.

| Variable                      | Required | Default                            | Notes                                                                                                                                                                           |
| ----------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | **Yes**  | —                                  | Postgres connection string. Every DB-touching script (migrate, ingestion, backend) fails loudly at startup if this is unset — see `src/backend/db/client.ts`.                   |
| `JUPITER_API_KEY`             | No       | unset (keyless)                    | Sent as `x-api-key` if set. Reads work keyless at low volume (see `docs/jupiter-prediction-discovery.md` §7.1); no key has been registered for this project.                    |
| `JUPITER_PREDICTION_BASE_URL` | No       | `https://api.jup.ag/prediction/v1` | Override for testing against a different host.                                                                                                                                  |
| `NEXT_PUBLIC_API_BASE_URL`    | No       | `http://localhost:4100`            | Baked into the frontend bundle at build/dev time; the frontend calls the backend directly (no Next.js proxy). Defaulted in code, so it works without a `.env` — see note below. |
| `PORT`                        | No       | `4100`                             | Backend HTTP port.                                                                                                                                                              |

**Note on `NEXT_PUBLIC_API_BASE_URL`**: the frontend runs via
`next dev src/frontend`, which scopes Next's own env-file loading to
`src/frontend` as its project root — a repo-root `.env` is not
automatically read there. The code default (`http://localhost:4100`)
already matches local dev, so this only matters if you're pointing the
frontend at a non-default backend URL; in that case, place an env file
directly under `src/frontend/` (e.g. `src/frontend/.env.local`).

## 6. Local development flow (the MVP loop)

Four steps, in order, each in its own terminal (or all at once via
`npm run dev:all` — see below):

```bash
# 1. Apply the schema (idempotent — safe to re-run)
npm run db:migrate

# 2. Populate the database with real trades (bounded: ~5 polls, exits on its own)
npm run dev:ingest:trades

# 3. Start the read-only backend (foreground, until Ctrl-C) — http://localhost:4100
npm run dev:backend

# 4. In another terminal: start the frontend (foreground, until Ctrl-C) — http://localhost:3000
npm run dev:frontend
```

Then open the frontend URL Next.js prints (it auto-picks the next free
port starting at 3000) — the live trade feed (`/`) connects to the
backend's SSE stream directly and starts rendering trades already in the
database, appending new ones as later ingestion runs add them.
`/dashboard` (Phase 3.8) is a second page, one plain `fetch` against
`GET /api/dashboard` on load — signals, top Smart Score wallets, whale
trades, market consensus, top active markets, and recently active smart
wallets in one view. `/wallet/:walletPubkey` (Phase 3.9) is a third page
— one `fetch` against `GET /api/wallets/:walletPubkey` rendering Smart
Score, stats, activity summary, market breakdown, positions, and recent
trades/history/score-history for one wallet; every wallet pubkey shown on
the live feed or dashboard links here. A shared nav bar (`app/layout.tsx`)
links between the live feed and dashboard. The dashboard and wallet pages
(Phase 3.10) both have a manual **Refresh** button and a "last updated"
timestamp — a refresh keeps the last-good data on screen (rather than
blanking to a loading state) and shows an inline error if it fails, so a
failed background refresh never wipes out what was already showing.

**Other ingestion jobs**, run on demand, each bounded and exits on its own
(none of them loop forever unless you explicitly pass `--forever` to
`ingest:trades:poll`, which the documented flow above never does):

```bash
npm run ingest:history:recent      # /history for the 5 most recently active wallets
npm run ingest:positions:recent    # /positions for the 5 most recently active wallets
npm run ingest:rankings            # /leaderboards (all 3 periods) + /profiles for the top 20 wallets
npm run analytics:scores           # compute + persist Smart Score snapshots (default 500 candidate wallets, no Jupiter calls)
npm run analytics:signals          # detect Smart Money Signals over a recent trade window, print JSON (no DB writes)
npm run analytics:signals:persist  # same detection, persists results into smart_money_signals (idempotent)
```

**All four steps in one command:**

```bash
npm run dev:all
```

Runs `db:migrate` then `ingest:trades:poll` to completion (both exit on
their own), then starts `backend:dev` and `frontend:dev` **concurrently**
in the same terminal (via `concurrently`, labeled/colored per process).
This is still two ordinary foreground dev servers — `dev:all` does not
daemonize, background, or detach anything; `Ctrl-C` stops both. Nothing
in this project is started via PM2, Docker, or any process manager (see
constraints below).

Verified (Phase 2.10): running it in an interactive terminal and pressing
`Ctrl-C` sends `SIGINT` to the whole foreground process group at once —
`concurrently`, `backend:dev`, and `frontend:dev` (and its own child `tsx
watch`/`next dev` processes) all exit together, freeing both ports, with
the backend logging its own graceful shutdown. (If you instead background
it with `&` and `kill` only the top-level PID, the children are left
running — that's a shell-scripting quirk of how you invoked it, not a
`dev:all` behavior; the standard `Ctrl-C` usage above is unaffected.)

**On "does anything run forever by accident"**: `backend:dev` and
`frontend:dev` are meant to keep running until you stop them — that's
normal for any dev server (identical to `next dev` or `nodemon` anywhere
else), not a background daemon; they hold your terminal and die with a
plain `Ctrl-C`/`SIGTERM`, with no auto-restart, no supervisor, and no
detachment. Every _ingestion_ job, by contrast, is bounded and exits on
its own — `ingest:trades:poll`'s own default is 5 iterations and
`forever: false`; the only way to make it loop indefinitely is to pass
`--forever` explicitly, which no script here does automatically.

## 7. Backend API reference

Base URL: `http://localhost:4100` (or `$PORT`).

| Endpoint                                                                                | Notes                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                           | `{ ok, uptimeSeconds, db, dbError }` — real `SELECT 1` check.                                                                                                                                                                                                             |
| `GET /api/trades/recent?limit=&marketId=&ownerPubkey=`                                  | `limit` default 50, max 200.                                                                                                                                                                                                                                              |
| `GET /api/trades/stream?limit=&marketId=&ownerPubkey=`                                  | SSE: `snapshot` on connect, `trade` per new row (5s poll), `heartbeat` every 25s.                                                                                                                                                                                         |
| `GET /api/wallets/:walletPubkey`                                                        | Wallet intelligence: profile, positions, recent trades/history, computed stats, Smart Score (latest + history), market breakdown, activity summary. Unknown wallet → 200 with nulls, not 404. See [`docs/wallet-intelligence-api.md`](./docs/wallet-intelligence-api.md). |
| `GET /api/leaderboards/latest?period=`                                                  | `period`: `all_time` (default) \| `weekly` \| `monthly`.                                                                                                                                                                                                                  |
| `GET /api/scores/latest?limit=&tier=&minScore=`                                         | Most recent persisted Smart Score snapshot bucket, sorted by score desc. `limit` default 50, max 200. See [`docs/smart-score.md`](./docs/smart-score.md) §6.                                                                                                              |
| `GET /api/signals/recent?source=persisted\|live&lookbackMinutes=&minSmartScore=&limit=` | Smart Money Signals. `source=persisted` (default) reads the `smart_money_signals` table; `source=live` recomputes on request. See [`docs/smart-money-signals.md`](./docs/smart-money-signals.md).                                                                         |
| `GET /api/dashboard?lookbackMinutes=&limit=`                                            | Combined read-only dashboard: signals, top Smart Score wallets, whale trades, market consensus, top active markets, recently active smart wallets. See [`docs/dashboard-api.md`](./docs/dashboard-api.md).                                                                |

All read-only against Postgres; none of them call Jupiter or trigger
ingestion.

## 8. Current limitations

Full detail in [`docs/mvp-status.md`](./docs/mvp-status.md). Headlines:

- Only the live trade feed has a frontend page — wallet detail and
  leaderboard pages have backend endpoints but no UI yet.
- No smart-money scoring/derivation logic exists — data is ingested and
  served as Jupiter computed it, nothing ranks or flags wallets yet.
- No scheduled/always-on ingestion — every job is a bounded, manually-run
  process; the database only stays fresh if someone re-runs the jobs.
- `/history` ingestion fetches only the first page per wallet, not a full
  paginated backfill.
- No registered API key, no auth in front of the backend, CORS wide open.
- No automated tests, no deployment, no CI.
- **The Phase 1 legal question is still open** — see §9 below.

## 9. Roadmap

1. **Legal/access verification** (carried over from Phase 1, still the
   top blocker) — get a direct answer from Jupiter on whether a public
   wallet-tracking/leaderboard product is permitted under the SDK & API
   License Agreement (`docs/jupiter-prediction-discovery.md` §7.6); confirm
   hosting-jurisdiction geo-restrictions. Only after that: register a real
   API key.
2. **Scheduled ingestion** — something that keeps the database fresh
   without a human re-running bounded jobs (still no PM2/Docker).
3. **Wallet + leaderboard frontend pages** on top of the endpoints that
   already exist.
4. **Smart-money scoring** — the actual point of this project; deferred
   until ingestion is continuous and trustworthy.
5. **`/history` pagination traversal**, hardening (tests, auth, a real
   deployment story) — see `docs/mvp-status.md` for the complete list.

## 10. Research summary

Full detail lives in [`docs/`](./docs); the headline findings:

- **Two products, one API surface**: "Jupiter Predict" (mature, documented)
  and "Jupiter Forecast" (newer, loosely-typed `/forecast` endpoint) share
  `api.jup.ag/prediction/v1`. This project targets Predict's well-typed
  endpoints (`/trades`, `/history`, `/leaderboards`, `/profiles/*`).
- **No on-chain indexing needed for MVP** — Jupiter's own reference app
  already exposes a global trade feed, wallet PnL history, and a leaderboard
  over REST. Every economically-meaningful event also carries a Solana
  `signature`/`slot`, so REST data can be cross-checked against `getTransaction`
  later without parsing raw instructions.
- **Reads work keyless** at ~0.5 req/s, but a registered key (free tier: 1
  req/s; paid tiers up to 150 req/s) is the sanctioned path for any real
  polling cadence.
- **24.4-hour live validation of the REST API** (`docs/rest-api-validation.md`):
  9,525 requests, 99.92% success, 0×5xx, 8×429 (all self-healing within one
  poll cycle, no permanent data loss), 0 duplicate/malformed/schema-drift
  events, 0 non-trivial full-`/trades`-window turnovers. **Verdict: REST API
  is safe enough as the MVP system of record**, with `/history` (genuinely
  paginated) as the completeness/reconciliation source behind `/trades`'
  live-feed presentation layer.
- **Real, unresolved legal risk**: the SDK & API License Agreement contains
  clauses (§2.2, §3.2(d), §3.2(g)) that plausibly restrict redistributing
  API content to third parties and combining it with independently-scraped
  on-chain data — this is the top blocker before any product code ships,
  not just an engineering nice-to-know. See
  [`docs/jupiter-prediction-discovery.md`](./docs/jupiter-prediction-discovery.md)
  §7.6.

## 11. Repository structure

```
docs/                          Phase 1 research + docs/mvp-status.md
scripts/                       Standalone research/validation scripts (Phase 1.9), not part of the app build
src/
  backend/
    api/                       Express app: server.ts, routes/{health,trades,wallets,leaderboards}.ts
    core/                      Pure raw -> domain normalization functions (no I/O)
    db/                        Postgres client, migration runner, migrations/, repositories/
    ingestion/                 Reusable ingestion services (one-shot + bounded-poll)
    jobs/                      CLI entry points (npm run ingest:*, backend:dev) — self-starting scripts
    services/                  jupiterPredictionClient.ts (typed, rate-limit-aware)
    types/                     jupiter.ts (raw upstream shapes) + domain.ts (normalized model)
    utils/                     decimal/string/time helpers shared by core + ingestion
  frontend/
    app/                       Next.js App Router: layout.tsx (shared nav), page.tsx (live feed), dashboard/page.tsx, wallet/[walletPubkey]/page.tsx, globals.css
      lib/format.ts            Shared formatting helpers (shortenPubkey, formatUsd/Score/Percent, formatDateTime/TimeOnly, formatDuration)
      components/              Shared presentational components: Badge, SectionCard, EmptyState, WalletLink, RefreshBar
  shared/                      Reserved for backend+frontend-shared types/utilities (unused so far)
```

Backend and frontend are one npm package (no workspaces); the frontend
has its own `next.config.mjs`/`tsconfig.json` under `src/frontend/` so its
bundler-mode TypeScript config never conflicts with the backend's
NodeNext-mode root `tsconfig.json`.

## 12. Tooling

- **TypeScript** (strict mode) — `npm run typecheck` (backend only; the
  frontend's `.tsx` files are type-checked by Next.js itself on
  `frontend:dev`/build, via `src/frontend/tsconfig.json`)
- **ESLint** (flat config, `typescript-eslint` recommended rules) —
  `npm run lint` / `npm run lint:fix`
- **Prettier** — `npm run format` / `npm run format:fix`
- **Build** — `npm run build` (backend only, emits to `dist/`, not committed)

Dependencies added so far, each for one concrete reason: `pg` (Postgres),
`express` (HTTP + SSE), `next`/`react`/`react-dom` (frontend),
`concurrently` (dev-only, runs backend+frontend together in `dev:all`).
No ORM, no CORS package (3 headers set manually — this API has no
cookies/auth to protect), no test framework yet, no Docker, no PM2.
