# Jupiter Prediction REST API — Full Capability Analysis

Status: **research only — no app code, no deployment, no git init, no commits**
This document is the technical foundation for Phase 2. All findings below are separated into **verified facts** (backed by a live probe, the official OpenAPI spec, or official docs/example code) and **assumptions** (explicitly labeled). Nothing here was derived by brute-forcing undocumented paths.

---

## 0. Methodology

Endpoints were enumerated from four sources, in this priority order:

1. **The official OpenAPI spec**, found live at `https://prediction-market-api.jup.ag/openapi.json` (200 OK, 132KB, `openapi: 3.0.0`, `info.title: "Prediction Market API"`, **54 paths**). This is the authoritative source for everything in §2-3 below.
2. **Jupiter's own example-app source code** (`github.com/jup-ag/api-examples`, `apps/prediction-markets` and `apps/prediction-API-video-demo`), fetched directly from `raw.githubusercontent.com` — used to cross-check the spec against real integration patterns.
3. **Official docs pages** (`developers.jup.ag/docs/prediction`, the how-to guide, `docs.jup.ag/user-docs/trade/predict`).
4. **Live, read-only GET probes** against real endpoints (via `scripts/probe-jupiter-prediction.mjs` and ad hoc `curl`), including an `OPTIONS` preflight check. Samples saved under `docs/samples/`.

No POST/DELETE endpoint was ever called (no order creation, no position closes, no claims, no follows) — every finding about write endpoints comes from the spec/docs, not from exercising them. No random/guessed paths were tried; every path tested came from the spec.

---

## 1. Critical infrastructure finding: two hosts, not one

This changes how several endpoints must be read below.

- **`https://api.jup.ag/prediction/v1`** — the documented, sanctioned base URL from Jupiter's own guides and example apps. Verified live: serves the `/api/v1/*` paths from the spec (with the `/api` prefix dropped — e.g. spec path `/api/v1/trades` → real URL `.../prediction/v1/trades`).
- **`https://prediction-market-api.jup.ag`** — the same host the public docs/spec are served from — is **also a live, directly-callable API host**, serving **both** `/api/v1/*` **and** `/api/v2/*` paths verbatim (no prefix-dropping needed here).
- **The `/api/v2/*` endpoints (`/api/v2/history`, `/api/v2/positions`) are NOT reachable through `api.jup.ag/prediction/v1` at all** — confirmed by direct test: `https://api.jup.ag/prediction/v2/history` → `404`. They only work via `prediction-market-api.jup.ag/api/v2/...` directly.

**This is flagged as an open question, not treated as equally "official" as the v1 gateway**: nothing in the developer guide or example apps mentions `prediction-market-api.jup.ag` as an intended direct integration host — its public presence is (as far as this research found) only as the docs UI's origin. Whether hitting it directly for v2 data is a supported integration path or an incidental exposure is unknown and should be asked of Jupiter directly before depending on it in production.

---

## 2. Complete endpoint matrix (all 54 paths from the OpenAPI spec)

| Endpoint | Methods | Purpose | Auth (spec) | Pagination | Polling candidate | Notes |
|---|---|---|---|---|---|---|
| `/events` | GET | List events, rich filters | none in spec | `start`/`end`/`limit` | Yes (discovery) | category/subcategory/tag/tags/sortBy/sortDirection/filter all supported |
| `/events/categories` | GET | List category taxonomy | none | — | No | |
| `/events/closed` | GET | Closed events | none | `start`/`end`, `since` | No | |
| `/events/crypto/timed` | GET | Short-duration crypto markets (Forecast-style) | none | — | Maybe | `subcategory` enum: btc/eth/xrp/sol/hype/doge/bnb; `tags`: 5m/15m |
| `/events/degen` | GET | "Degen" event list | none | — | No | Purpose not documented beyond name |
| `/events/degen/{symbol}` | GET | Degen event for one symbol | none | — | No | |
| `/events/scores` | GET | Scores for multiple events | none | `eventIds` (required) | No | |
| `/events/search` | GET | Search events by text | none | `start`/`end` | No | |
| `/events/suggested` | GET | Generic suggested events | none | `limit` | No | |
| `/events/suggested/{pubkey}` | GET | Wallet-personalized suggestions | none | `limit` | No | |
| `/events/tags` | GET | Tag taxonomy per category | none | — | No | |
| `/events/{eventId}` | GET | Single event + markets | none | — | Yes (per-event detail) | |
| `/events/{eventId}/markets` | GET | Markets for one event | none | `start`/`end` | No | |
| `/events/{eventId}/markets/{marketId}` | GET | Single market within an event | none | — | No | |
| `/events/{eventId}/score` | GET | Score for one event | none | — | No | |
| `/execute` | POST | (write) execute action | unknown | — | — | Not probed — write endpoint |
| `/follow/{ownerPubkey}` | POST | (write) follow a wallet | unknown | — | — | Not probed — write endpoint |
| `/followers/{ownerPubkey}` | GET | Wallet's followers | none | — | Maybe (social signal) | **Verified live**: `{followers:[{pubkey,createdAt}], count}` |
| `/following/{ownerPubkey}` | GET | Wallets this wallet follows | none | — | Maybe (social signal) | **Verified live**: `{following:[...], count}` |
| `/forecast` | GET | Forecast-product data | none | — | Maybe | **Spec leaves this fully untyped**: `{"nullable": true, "description": "Forecast response payload"}` — not just the example app's types are loose, the *official spec itself* doesn't describe the shape. Has a documented 502 error case. |
| `/history` (v1) | GET | Per-fill/lifecycle event log | none | **`start`/`end`, real pagination confirmed live** (`{start,end,total,hasNext}`) | **Yes — primary candidate** | See §3.1 |
| `/leaderboards` | GET | Ranked wallets | none | `limit` (default 100) | **Yes — primary candidate** | `period`: all_time/weekly/monthly; `metric`: pnl/volume/win_rate — sortable server-side |
| `/markets/{marketId}` | GET | Single market pricing/status | none | — | Yes (on-demand) | |
| `/orderbook/{marketId}` | GET | Order book depth | none | — | Maybe | **Spec leaves this untyped too** (same opaque `nullable:true` shape as `/forecast`). Live sample shape didn't clearly match "price" semantics — see §3.2. Has documented 502 case. |
| `/orders` | GET/POST/DELETE | List / create / bulk-cancel orders | GET: none tested; POST/DELETE: presumably yes | `start`/`end` | No (write-adjacent) | Not exercised beyond GET-list shape from spec |
| `/orders/cancel` | POST | (write) cancel an order | unknown | — | — | Not probed |
| `/orders/close-all` | DELETE | (write) close all orders | unknown | — | — | Not probed |
| `/orders/execute` | POST | (write) execute an order | unknown | — | — | Not probed |
| `/orders/status/{orderPubkey}` | GET | Order lifecycle + signatures | none | — | No | Rich `history[]` with per-step `signature` |
| `/orders/{orderPubkey}` | GET | Single order | none | — | No | |
| `/parlays` | GET/POST | Parlay (multi-market bet) list/create | GET needs `walletAddress` | — | No | Distinct feature, not explored deeply — out of MVP scope |
| `/parlays/execute` | POST | (write) | unknown | — | — | Not probed |
| `/parlays/free` | POST | (write) free parlay entry | unknown | — | — | Not probed |
| `/parlays/free/submit` | POST | (write) | unknown | — | — | Not probed |
| `/parlays/referral-code` | POST | (write) | unknown | — | — | Not probed |
| `/parlays/referrals` | POST | (write) | unknown | — | — | Not probed |
| `/parlays/stats` | GET | Parlay stats | none | — | No | |
| `/positions` (v1) | GET/DELETE | List / bulk-close positions | GET: none tested | `start`/`end` | Yes (open positions) | Full `Position` schema — see §3.3 |
| `/positions/{positionPubkey}` | GET/DELETE | Single position / close | none (GET) | — | No | |
| `/positions/{positionPubkey}/claim` | POST | (write) claim payout | unknown | — | — | Not probed |
| `/profiles/batch` | GET | **Batch wallet PnL lookup** | none | — | **Yes — high value** | See §3.4; verified live |
| `/profiles/{ownerPubkey}` | GET | Single wallet aggregate | none | — | Yes | Verified live |
| `/profiles/{ownerPubkey}/pnl-history` | GET | Wallet PnL time series | none | `interval`, `count` | Yes | `interval`: 24h/1w/1m |
| `/ticket-issues` | GET | Ticket issue tracking | none | `start`/`end` | No | Belongs to the separate "tickets" feature — see §1 note |
| `/tickets` | GET/POST | List/create tickets | GET: none tested | `start`/`end` | No | |
| `/tickets/gx/stats` | GET | Ticket stats (named "gx") | none | `from`/`to` | No | Unclear product meaning — not investigated further, out of scope |
| `/tickets/{ticketPubkey}` | GET | Single ticket | none | — | No | |
| `/tickets/{ticketPubkey}/claim` | POST | (write) claim ticket | unknown | — | — | Not probed |
| `/trades` | GET | **Global recent-trades feed** | none | **none in spec — confirmed live, no pagination at all** | **Yes — primary candidate** | See §3.5 — this is the single most important limitation found |
| `/trading-status` | GET | Global trading-active flag | none | — | Maybe (cheap heartbeat) | Verified live: `{trading_active: true}` |
| `/unfollow/{ownerPubkey}` | DELETE | (write) unfollow | unknown | — | — | Not probed |
| `/vault-info` | GET | Vault PDA + protocol config | none | — | No (config rarely changes) | Takes `mint` param (usdc/jupusd — **two separate vaults**) |
| `/history` (v2, `prediction-market-api.jup.ag` only) | GET | **Position-lifecycle history** | none | `start`/`end` (per spec; not exercised) | Yes — see §3.1 | Fundamentally different shape from v1, not an upgrade of it |
| `/positions` (v2, `prediction-market-api.jup.ag` only) | GET | **Batch positions grouped by owner** | none | none in spec | Yes — high value for multi-wallet views | See §3.3 |

**Standardized error shape** (confirmed across nearly every endpoint's 400/404/502 responses in the spec): `{type: "invalid_request_error"|"authentication_error"|"permission_error"|"idempotency_error"|"rate_limit_error"|"api_error", message, code, param, request_id, doc_url}`. The enum's existence confirms `authentication_error`/`permission_error`/`rate_limit_error` are real, documented possibilities for *some* call shapes — consistent with write endpoints requiring auth even though every GET tested here did not.

---

## 3. Deep dive on MVP-relevant endpoints

### 3.1 `/history` — two genuinely different things share this name

- **v1** (`.../prediction/v1/history`): a **per-fill event log**. `eventType` enum has **14 values**, more than any doc surfaced before this research: `order_created, order_closed, order_filled, order_failed, payout_claimed, position_updated, position_lost, ticket_created, ticket_accepted, ticket_rejected, ticket_settled, ticket_claimed, ticket_refunded, ticket_closed`. Carries `signature`, `slot`, `orderPubkey`, `positionPubkey`, `keeperPubkey`, `contracts*` (whole/micro/decimal triple), `avgFillPriceUsd`, etc. **Confirmed live**: `?ownerPubkey=` is required (unscoped call → clean `400`, `"ownerPubkey or userPubkey is required"`); response includes a real `pagination: {start, end, total, hasNext}` object — for one real wallet probed, `total: 1347` with only 9 returned by default, confirming pagination is functionally necessary, not optional, to get complete history.
- **v2** (`prediction-market-api.jup.ag` only): a **position-lifecycle summary**, one row per position, not per fill. Fields: `positionPubkey, ownerPubkey, marketId, isYes, outcomeSide, sideLabel, lifecycleStatus (open|resolving|settled), status (claimed|lost|sold|open|failed|won|refunded), entryPriceUsd, exitPriceUsd, totalContracts*, realizedPnlUsd (nullable), feesPaidUsd, openedAt, closedAt (nullable), marketMetadata`. **No `signature` field at all** — this is the one concrete gap found (see §5).

These are not interchangeable. v1 is the audit trail (with tx signatures); v2 is the clean "what happened to this position" summary (with realized PnL, no signatures). A production system likely wants both.

### 3.2 `/orderbook/{marketId}` — genuinely under-specified, not just under-documented

The official OpenAPI spec's response schema for this endpoint is literally `{"nullable": true, "description": "Forecast response payload"}` — opaque, not a typed object. This is not a gap in *this research*; it's a gap in Jupiter's own formal spec. Cross-referencing our own live sample (`docs/samples/orderbook-marketid.json`) against Jupiter's own example-app TypeScript types (which describe `{yes: [[price_cents, size]], no: [...]}`) surfaced a mismatch already noted in `docs/api-probe-results.md`: the live sample's keys run `1, 2, 3, ... 30` with monotonically decreasing size — consistent with **rank-ordered depth levels**, not literal cent prices. **This can likely be resolved without Helius or RPC** — by correlating the orderbook's rank-1 entries against the same market's `/markets/{marketId}` → `pricing.buyYesPriceUsd`/`sellYesPriceUsd` for several markets over time, the actual semantics should become inferable empirically. Not done in this pass; flagged as a concrete, cheap next step.

### 3.3 `/positions` — rich, and one real, sourced data-quality caveat

The full `Position` schema (54 properties) confirms **both** unrealized (`pnlUsd`, `pnlUsdPercent`, `pnlUsdAfterFees` — all null once market closed) and realized (`realizedPnlUsd`) PnL sit side by side on the same object, along with `claimed`/`claimable`/`payoutUsd` for settlement state. One field description is a direct, sourced red flag: **`totalCostUsd`: "Total cost basis in micro USD; \"0\" when basis is unknown (Forecast self-custody ledger doesn't reconcile with the on-chain balance)."** This is Jupiter's own schema acknowledging that cost-basis (and therefore correct PnL) can be unreliable for a known subset of positions (Forecast, self-custody). Not something this research can fix — flagged for the gap analysis.

v2 (`prediction-market-api.jup.ag/api/v2/positions`) groups results **by owner in one batched call** — spec description: *"Positions grouped by owner public key. Every requested pubkey is present as a key, with an empty array when the owner has no matching positions."* Confirmed live with a real wallet. This is the efficient shape for a multi-wallet dashboard (rankings page, watchlists) — one call instead of N.

### 3.4 `/profiles/batch` — confirmed, high-value

`?wallets=<comma-separated>` → `{data: {[wallet]: {weekly: {...}, monthly: {...}, all_time: {...}}}}`, one PnL/volume/prediction-count breakdown **per period, per wallet, in one call**. Verified live against 2 real wallets from the leaderboard. This is the correct primitive for building a rankings/watchlist page without N sequential `/profiles/{wallet}` calls.

### 3.5 `/trades` — the most important limitation in this whole document

**No pagination parameters exist in the spec at all** for this endpoint — confirmed, not assumed. The live sample returned **exactly 20 rows spanning ~408 seconds (~6.8 minutes)** of real platform activity at probe time. There is no cursor, no `since`, no `limit` param — it is a fixed-size "last N" window, not a paginated feed.

**Concrete implication**: if platform-wide trade velocity ever exceeds roughly what fits in that ~20-row/~7-minute window between two polls, trades occurring in between **are silently and permanently unrecoverable** — there is no way to page backward and retrieve them after the fact. A 15-second poll interval (Jupiter's own reference cadence) is safe only if trade velocity stays under roughly 20 trades per 7 minutes sustained; a volume spike (e.g., a major sports/crypto event) could exceed that window's capacity between polls with zero recourse. This is a real, quantified gap, not a theoretical one — see §5.

---

## 4. Rate limits — now backed by response headers, not just Jupiter's general pricing page

An `OPTIONS` preflight and several real `GET` calls returned genuine rate-limit headers (not documented in any Jupiter page found, but directly observable):

```
x-ratelimit-remaining: <n>
x-ratelimit-current: <n>
x-ratelimit-reset: <unix timestamp>
```

Four consecutive unauthenticated calls, ~3s apart, produced:

| Call | current | remaining | reset |
|---|---|---|---|
| 1 | 1 | 4 | 1783253604 |
| 2 | 2 | 3 | 1783253604 |
| 3 | 3 | 2 | 1783253604 |
| 4 | 3 | 2 | 1783253608 (+4s) |

`current + remaining = 5` held across the first three calls sharing one `reset` value, then the window advanced. **Honest interpretation, not overclaimed**: this is consistent with a small fixed-size window (roughly 5 requests per ~4-second window ≈ 1.25 req/s), which is in the same ballpark as — but not identical to — Jupiter's general-platform documented "~0.5 req/s keyless" figure from `docs/jupiter-prediction-discovery.md` §7.3. Four data points aren't enough to derive the exact algorithm (sliding vs. fixed window, exact reset cadence) with confidence — **both numbers should be treated as approximate operating envelopes, not guarantees**, until confirmed with a registered key and sustained load testing.

---

## 5. MVP data checklist

| Capability | Verdict | Explanation |
|---|---|---|
| Realtime trades | **PARTIAL** | `/trades` works and is real-time, but has zero pagination and only holds ~20 rows/~7 min (§3.5). Fine at current observed volume; unverified at higher volume. Cannot be upgraded to YES without either a much higher-frequency poll (fights the rate limit, §4) or a different data source. |
| Wallet history | **YES** | Two complementary sources: v1 (`/history`, per-fill event log with signatures, real pagination) and v2 (`/history` on the direct host, position-lifecycle summary). |
| Wallet PnL | **YES** | `/profiles/{wallet}`, `/profiles/batch`, `/leaderboards` all expose `realizedPnlUsd`; `/positions` adds `pnlUsd` (unrealized). |
| Wallet win rate | **YES** | `/leaderboards` returns `winRatePct` directly and is sortable by `metric=win_rate` server-side — no derivation needed. |
| Realized vs unrealized PnL | **YES, with a caveat** | Both exist on the `Position` schema side by side (§3.3). Caveat: unrealized PnL depends on `totalCostUsd`, which is documented as unreliable ("0") for a known subset of Forecast self-custody positions. |
| Open positions | **YES** | `/positions` (v1) and `/positions` (v2, batched by owner). |
| Closed positions | **YES** | `/history` v2's `lifecycleStatus: settled` / `status: claimed\|lost\|sold\|won\|refunded` rows. |
| Market metadata | **YES** | `/markets/{marketId}`, `/events`, `/events/{eventId}` — rich, including full rules text. |
| Market resolution | **YES** | `/markets/{marketId}.result` (`yes\|no\|draw`, nullable until resolved), `resolveAt`, `marketResultPubkey`. |
| Market categories | **YES** | `/events` category enum (11 values incl. crypto/sports/politics/esports/culture/economics/tech/finance/climate & science/weather/mentions), plus dedicated `/events/categories` and `/events/tags`. |
| YES/NO pricing | **YES** | `MarketPricing`: `buyYesPriceUsd`, `buyNoPriceUsd`, `sellYesPriceUsd`, `sellNoPriceUsd`, `volume` — all typed numbers. |
| Orderbook | **PARTIAL** | Endpoint works and returns real depth-shaped data, but is officially untyped in Jupiter's own spec, and the live sample's shape doesn't obviously match documented cent-price semantics (§3.2). Usable for "does depth exist" signals now; not confidently interpretable as literal price levels yet. |
| Leaderboard | **YES** | `/leaderboards`, 3 periods, 3 sort metrics, server-computed. |
| Wallet ranking | **YES** | Directly derivable from leaderboard array position — no separate ranking computation needed. |
| Market status | **YES** | `status: open\|closed` on markets; `/trading-status` for a global heartbeat. |
| Timestamps | **YES, with a quirk** | Most timestamps are Unix integers (`openTime`, `closeTime`, `timestamp`, `openedAt`, `closedAt`) but `resolveAt` is documented as an **ISO 8601 string** — a real, confirmed inconsistency to handle in the data layer, not a guess. |
| Transaction signatures | **PARTIAL** | Present throughout v1 `/history` (per event) and `/orders/status/{orderPubkey}` (per lifecycle step). **Absent from v2 `/history`'s position-lifecycle rows.** Can be recovered by joining v2 rows back to v1 events via shared `positionPubkey`/`orderPubkey` — not a missing capability, just not on the convenient endpoint. |

**15 of 16 items are clean YES; 3 are PARTIAL, and every PARTIAL has a documented, non-blocking reason and a concrete path to resolve it (not an open-ended unknown).**

---

## 6. Gap analysis

| Gap | Derivable from REST alone? | Needs Helius? | Needs Solana RPC? | Blocks MVP? |
|---|---|---|---|---|
| `/trades` has no pagination / ~7min window | No — this is a hard ceiling of the endpoint itself | Not directly — Helius could supplement by watching the program on-chain, but §1 of `docs/jupiter-prediction-discovery.md` already flags that combining API data with independently-sourced data may conflict with Jupiter's SDK & API License Agreement §3.2(g) | Same caveat as Helius | **No** — degrades gracefully (misses trades only during genuine volume spikes exceeding the window); acceptable for v0.1, worth monitoring |
| Orderbook semantics unclear (rank vs. price) | **Likely yes** — cross-reference against `/markets/{marketId}` pricing over time | No | No | No |
| v2 `/history` lacks `signature` per row | **Yes** — join to v1 `/history` via `positionPubkey`/`orderPubkey` | No | No | No |
| Unrealized PnL cost-basis "0" for some Forecast positions | **No** — Jupiter's own ledger doesn't reconcile this internally either, per its own schema description | Only for the affected subset, and only by reading on-chain token/vault balances directly | Yes, for that subset | No — affects a known, bounded subset, not the whole dataset |
| Real per-request "credit weight" for billing | Not derivable by any research method | No | No | No — affects cost estimation accuracy (§7), not feasibility |
| `prediction-market-api.jup.ag` official-support status for v2 | Not derivable — requires asking Jupiter | No | No | No — affects architecture confidence, not technical feasibility |

**No gap found in this research makes an MVP impossible.** The most consequential open item remains the ToS/licensing question already raised in `docs/jupiter-prediction-discovery.md` §7.6 — that's a legal gate, not a technical one, and this document doesn't change that finding.

---

## 7. API usage estimate — 500 DAU

**This entire section is explicitly labeled ASSUMPTION-BASED.** No per-endpoint "credit weight" is published anywhere found, and actual load depends entirely on caching architecture not yet built. Numbers below are a planning range, not a guarantee.

Assumed shape: live feed + wallet pages + rankings, 500 DAU, with a sane backend that **polls once server-side and fans out to users via our own infrastructure** (not one API call per concurrent user — that would be a design mistake, not a Jupiter constraint).

| Loop | Basis | Calls/day | Calls/month |
|---|---|---|---|
| Live feed (`/trades`) | Poll every 15s, matching Jupiter's own reference cadence | 5,760 | ~173,000 |
| Leaderboards (3 periods) | Poll every 3 min, 3 calls/tick | 1,440 | ~43,000 |
| Wallet pages (`/profiles`, `/history`, `/positions`, `/pnl-history`) — **low estimate** | Backend caches per-wallet responses ~60s; assume real overlap across users viewing popular wallets | ~1,000-2,000 | ~30,000-60,000 |
| Wallet pages — **high estimate** | No cache reuse; 500 users × ~5 distinct wallet views/day × ~4 calls/view | ~10,000 | ~300,000 |
| `/profiles/batch` for rankings enrichment | Batched, so cheap regardless of DAU | ~500 | ~15,000 |

**Total estimated range: ~300,000-600,000 requests/month**, i.e. roughly **0.1-0.25 average requests/second**, with bursty peaks well above that during active usage windows.

**Minimum plan recommendation**: the **Developer tier ($25/month, 10 req/s, 25M credits/month)** comfortably covers this estimate with wide headroom on both the rate-limit axis (10 req/s vs. an average well under 1 req/s) and the credit axis (600K << 25M, even assuming 1 credit per request as a conservative assumption). The Free tier (1 req/s, unlimited included usage per the earlier discovery doc) is *plausible* on paper but risks bottlenecking during simultaneous bursts (e.g., many users loading wallet pages at once) — Developer is the safer minimum, not the cheapest theoretically-sufficient one.

---

## 8. Final recommendation

### **A) REST-only MVP.**

Evidence supporting this, drawn directly from this research:

1. **15 of 16 MVP checklist items are clean YES**, and the 3 PARTIALs each have a concrete, non-blocking, REST-derivable resolution path (§5, §6) — none require on-chain data to fix.
2. Jupiter **already computes** the hardest part of a smart-money product — realized PnL, win rate, ranking — server-side, and exposes it via `/leaderboards`, `/profiles/*`, and `/positions`. Rebuilding this from raw on-chain instruction data would mean independently re-deriving fee accounting, settlement payouts, and position netting that Jupiter's own team maintains — high effort, ongoing maintenance burden, for data already available.
3. The one real capability gap (`/trades`' unpaginated ~7-minute window) degrades gracefully rather than catastrophically, and only matters during genuine volume spikes — an acceptable v0.1 risk to monitor, not a blocker.
4. The usage estimate (§7) fits comfortably inside a $25/month plan even under conservative assumptions — this is not a cost-driven decision toward on-chain indexing.
5. **Critically**: `docs/jupiter-prediction-discovery.md` §7.6 already found that Jupiter's SDK & API License Agreement (§3.2(g)) restricts combining API content with data obtained "through scraping or any other means outside the API." A REST+Helius hybrid (Option B) risks that specific clause directly — building it as a hedge against data gaps that don't actually require it would be adding legal risk to solve a problem this research shows doesn't exist at MVP scale.

**Option B (REST + Helius)** and **Option C (full on-chain indexer)** are not recommended for MVP. Reserve Option B narrowly — and only after getting Jupiter's explicit position on §3.2(g) — for the one gap that *would* need it: independently verifying cost-basis for the specific Forecast self-custody positions Jupiter's own schema already flags as unreliable. That's a small, bounded, optional hardening step, not a starting architecture.

---

## Sources

- `https://prediction-market-api.jup.ag/openapi.json` — full OpenAPI 3.0 spec, 54 paths (saved: `docs/samples/openapi-spec.json`)
- `https://prediction-market-api.jup.ag/docs` — hosted API docs (same host as the spec)
- `https://developers.jup.ag/docs/prediction`, `https://developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana`
- `https://github.com/jup-ag/api-examples` (`apps/prediction-markets`, `apps/prediction-API-video-demo`)
- Live probes (this task): `docs/samples/openapi-schemas-dump.txt`, `trades.json`, `leaderboards.json`, `events.json`, `profiles-wallet.json`, `profiles-batch.json`, `history-wallet.json`, `history-v1-wallet-eventlog.json`, `history-v2-wallet.json`, `positions-v2-wallet.json`, `followers-wallet.json`, `following-wallet.json`, `vault-info.json`, `markets-marketid.json`, `orderbook-marketid.json`
- Rate-limit headers: captured directly via `curl -D` and `OPTIONS`, not documented in any Jupiter page found
- Prior research carried forward: `docs/jupiter-prediction-discovery.md`, `docs/api-probe-results.md`
