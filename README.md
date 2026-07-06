# VictoryLabs Trade

Smart Money analytics platform for **Jupiter Prediction** (Solana's on-chain
prediction markets product, `api.jup.ag/prediction/v1`).

Status: **Phase 2 — project foundation only.** No business logic, no
database, no API server, no frontend, and no deployment exist yet. This
repository currently contains the research produced in Phase 1 plus a clean,
empty scaffold for the code that will be built on top of it in later phases.

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
        │  polling (no websocket variant exists)
        ▼
 backend/ingestion   — polls /trades, /history on independent intervals
        ▼
 backend/db          — Postgres, upsert-keyed by upstream id (not yet built)
        ▼
 backend/services    — wallet aggregation, smart-money derivation
        ▼
 backend/api         — HTTP layer serving the frontend (not yet built)
        ▼
 frontend            — presentation layer (not yet built, framework TBD)
```

`backend/core` holds framework-free domain logic; `backend/jobs` holds
scheduled/periodic tasks (leaderboard snapshots, wallet enrichment);
`backend/types` and `shared` hold TypeScript types — `shared` specifically
for anything both backend and frontend need, so the frontend never imports
from `backend/*` directly.

This project is **read-only by design**: tracking smart money never
requires signing or submitting a transaction, so there is no wallet,
keypair, or signing capability anywhere in this architecture.

## 3. Current status

- ✅ Phase 1 research complete (API surface, data model, rate limits, legal
  review) — see [`docs/`](./docs).
- ✅ Phase 1.9: 24.4-hour live REST API reliability validation complete —
  see [`docs/rest-api-validation.md`](./docs/rest-api-validation.md).
- ✅ Phase 2 (this phase): production project skeleton — directory
  structure, TypeScript/ESLint/Prettier tooling, no business logic.
- ⬜ Phase 3+: not started. See roadmap below.

## 4. Roadmap

1. **Legal/access verification** — get a direct answer from Jupiter on
   whether a public wallet-tracking/leaderboard product is permitted under
   the SDK & API License Agreement (flagged as the top open risk in
   [`docs/jupiter-prediction-discovery.md`](./docs/jupiter-prediction-discovery.md)
   §7.6/§12); confirm hosting-jurisdiction geo-restrictions; then register
   a real API key.
2. **Ingestion-only backend** — `/trades` (15s) and `/history` (60s)
   polling loops into Postgres, upserted by upstream id. No analysis layer
   yet; validate against real data for a few days first.
3. **Wallet aggregation** — periodic `/leaderboards` + `/profiles/*`
   snapshotting, joined against ingested trades.
4. **Smart-money surfacing** — UI/alerting layer on top of the above.
5. **(Optional, later)** on-chain/Helius indexing, reached for only if the
   REST API proves insufficient in practice — not needed for MVP per the
   Phase 1 findings.

## 5. Research summary

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

## 6. Repository structure

```
docs/                          Phase 1 research (discovery, capability
                                analysis, live API probes, 24h+ validation
                                report and its raw data samples)
scripts/                       Standalone research/validation scripts —
                                not part of the application build
src/
  backend/
    api/                       HTTP/API layer (routes, controllers)
    core/                      Framework-free domain/business logic
    db/                        Database access (schema, migrations, queries)
    ingestion/                 Jupiter Prediction REST API polling
    jobs/                      Scheduled/background jobs
    services/                  Orchestrates core + db + ingestion
    types/                     Backend-only TypeScript types
    utils/                     Small backend-only helpers
  frontend/                    Frontend application (framework TBD)
  shared/                      Types/utilities shared by backend + frontend
```

Every directory above currently contains only a placeholder `index.ts`
(a purpose comment + `export {}`) — enough for TypeScript/ESLint to have
real files to check, with zero business logic.

## 7. Tooling

- **TypeScript** (strict mode) — `npm run typecheck`
- **ESLint** (flat config, `typescript-eslint` recommended rules) —
  `npm run lint` / `npm run lint:fix`
- **Prettier** — `npm run format` / `npm run format:fix`
- **Build** — `npm run build` (emits to `dist/`, not committed)

No database, HTTP framework, or frontend framework dependency has been
added yet — those are deferred to the phase that actually implements them,
per this phase's scope (project foundation only).
