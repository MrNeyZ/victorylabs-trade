# Jupiter Prediction — Smart-Money Tracker: Technical Discovery

Status: **research only — no app code, no deployment, not committed**
Scope: `/root/vl-trade` (new, standalone project — no relation to `nft-live-feed`)

---

## 1. Executive summary

Jupiter has **two related, differently-mature products** under the "prediction markets" umbrella, and this distinction matters for everything below:

- **Jupiter Predict** — the current, documented product. Aggregates external prediction-market liquidity (Polymarket, Kalshi) into a single Solana-native trading UI. Has a real, versioned, beta REST API (`https://api.jup.ag/prediction/v1`) with a **global recent-trades endpoint, a leaderboard, and per-wallet PnL history already computed by Jupiter** — verified directly against Jupiter's own official example apps (source below), not inferred.
- **Jupiter Forecast** — a newer, less-documented layer that adds a "propAMM" (competing market-maker) liquidity mechanism natively on Solana, rolled into the same `Predict` interface. Public technical detail is thin; the same API exposes a `/forecast` endpoint but with a loosely-typed response even in Jupiter's own reference code (`ForecastData { [key: string]: unknown }`), meaning Jupiter's own developer-facing types haven't stabilized around it yet.

**The single most important finding**: Jupiter's own official example application (`jup-ag/api-examples`, `apps/prediction-markets`) already implements a **"Fetch recent platform-wide trades"** feed (`GET /trades`, polled every 15s) and a **wallet-level leaderboard with realized PnL / win-rate / volume** (`GET /leaderboards`, `GET /profiles/{ownerPubkey}`, `GET /profiles/{ownerPubkey}/pnl-history`). This is essentially the core of a smart-money tracker, already computed by Jupiter, exposed over a documented (if beta) REST API — no on-chain log-parsing required to get started, which is a materially different and safer starting point than `nft-live-feed`'s raw-transaction-decoding architecture for NFT marketplaces (which exists precisely because ME/Tensor/MMM don't offer that kind of first-party API).

---

## 2. Official docs / API surface (verified)

| What | Value | Source |
|---|---|---|
| Base URL | `https://api.jup.ag/prediction/v1` | `developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana`; confirmed again in `jup-ag/api-examples/apps/prediction-markets/lib/constants.ts` |
| Auth | Header `x-api-key`, obtained via Jupiter's Developer Portal (`developers.jup.ag/portal`) | Same guide; confirmed server-side in `apps/prediction-API-video-demo/.../route.ts` (proxy fails with "Missing JUPITER_API_KEY" if absent — **reads require a key too, not just writes**) |
| Status | **Beta**, "subject to breaking changes," feedback via Discord | `developers.jup.ag/docs/prediction` |
| Geo-restriction | US and South Korea IPs blocked from the API; Jupiter's mobile app blocks additional regions (parts of the EU) | `developers.jup.ag/docs/prediction`, `docs.jup.ag/user-docs/trade/predict` |
| Docs entry points | `developers.jup.ag/docs/prediction`, `developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana`, `prediction-market-api.jup.ag/docs`, `docs.jup.ag/user-docs/trade/predict`, `support.jup.ag` article | multiple, cross-checked |

### Endpoint inventory (from Jupiter's own reference app source, not guessed)

Reconstructed directly from `apps/prediction-markets/lib/api.ts` in `jup-ag/api-examples` (fetched raw from GitHub):

| Endpoint | Method | Purpose |
|---|---|---|
| `/events` | GET | List events (filters: category, subcategory, provider, sort, `filter=new\|live\|trending`, `includeMarkets`) |
| `/events/{eventId}` | GET | Single event + markets |
| `/events/search` | GET | Search events by query |
| `/events/suggested/{pubkey}` | GET | Wallet-personalized suggested events |
| `/events/{eventId}/markets` | GET | Markets for one event |
| `/markets/{marketId}` | GET | Single market pricing/status |
| `/orderbook/{marketId}` | GET | Current bid/ask book, `[price_cents, size]` tuples |
| `/trading-status` | GET | `{ trading_active: boolean }` |
| `/forecast` | GET | Forecast-product data (loosely typed — see §1) |
| `/orders` | GET/POST | List orders (filter by `ownerPubkey`) / create an order |
| `/orders/{orderPubkey}` | GET | Single order |
| `/orders/status/{orderPubkey}` | GET | Order lifecycle history incl. **on-chain signature per step** |
| `/positions` | GET/DELETE | List positions (filter by owner/market) / close |
| `/positions/{positionPubkey}` | GET/DELETE | Single position / close |
| `/positions/{positionPubkey}/claim` | POST | Claim settled payout |
| **`/history`** | GET | **Rich per-fill event log** — see §4, supports optional `ownerPubkey`, `positionPubkey`, pagination |
| `/profiles/{ownerPubkey}` | GET | Wallet aggregate: realized PnL, volume, prediction count, win/loss count |
| `/profiles/{ownerPubkey}/pnl-history` | GET | Wallet PnL time series |
| **`/leaderboards`** | GET | Ranked wallets by PnL/volume/win-rate, `period=all_time\|weekly\|monthly` |
| **`/trades`** | GET | **"Fetch recent platform-wide trades"** (Jupiter's own UI copy, `trades-feed.tsx`) — global, not wallet-scoped |
| `/vault-info` | GET | Vault PDA pubkey + balance — see §5 for why this matters |

Rate limits: **not documented anywhere found.** Jupiter's own reference app polls `/trades` at a fixed 15-second interval (`use-social.ts`, `refetchInterval: 15_000`) — the one concrete, official signal for a safe default cadence.

---

## 3. YES/NO representation and price units

- Every market is strictly binary: YES or NO. A winning contract pays exactly **$1** (or $1 of the settlement asset) per contract.
- Prices are quoted in USD, **$0.01–$0.99**, and are read directly as implied probability (a $0.70 YES ≈ 70% implied chance). YES + NO prices sum to ≈$1.00.
- On-chain/API amounts use **micro-USD**: `1,000,000 = $1.00`. The Jupiter dev guide explicitly warns to parse these as `BigInt`, not `Number`, to avoid precision loss. Contract counts have a parallel `*Micro` / `*Decimal` / legacy-whole-number triple in some responses; fills round down to 0.01-contract increments.
- Settlement/deposit currency: **USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) or **JupUSD** (`JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD`), per `depositMint` in order creation.

---

## 4. Transaction / execution pattern

Execution is a **hybrid on-chain + keeper-matched** flow, not a pure off-chain order book:

1. Client calls `POST /orders` with `ownerPubkey`, `marketId`, `isYes`, `isBuy`, `depositAmount` (micro-USD) or `contracts`, `depositMint`.
2. API returns an **unsigned, base64-encoded Solana transaction** (`CreateOrderResponse.transaction`) plus `txMeta` (blockhash, lastValidBlockHeight).
3. Client signs locally and submits to Solana.
4. A **keeper network** matches and fills the order on-chain.
5. Per Jupiter's dev guide, position creation involves **three on-chain transactions**: order creation, keeper-executed fill, order closure.
6. `GET /orders/status/{orderPubkey}` returns a `history[]` array where **every lifecycle step carries its own Solana `signature`** — confirmed in the `OrderStatus` type from the reference app.
7. `GET /history` (the rich per-fill log, not just order status) also carries `signature` **and** `slot` per row (`HistoryEvent.signature`, `HistoryEvent.slot`) alongside `keeperPubkey`, `realizedPnl`, `realizedPnlBeforeFees`, `feeUsd`, `payoutAmountUsd`. This means **every economically-meaningful event the REST API surfaces is already tied to a verifiable on-chain transaction** — useful for cross-checking REST data against `getTransaction` later without needing to parse raw instructions ourselves.

On-chain account types referenced (all PDAs, no explicit program ID published in any doc found):
- **Position Account** — user's position in a market.
- **Order Account** — user's order.
- **Vault Account** — holds funds; `GET /vault-info` returns this account's **pubkey directly**.

**Practical way to obtain the actual program ID** (not found in any doc, but derivable): call `/vault-info`, take the returned `pubkey`, and do a single `getAccountInfo` RPC call (via Helius or any RPC) — the account's `.owner` field **is** the Prediction Market program ID, since vault accounts are PDAs owned by that program. This is a five-minute verification step for whoever starts implementation, not a blocker for planning.

---

## 5. Can trades be indexed via Helius?

**Yes, technically — but it is very likely not the right MVP starting point, and here's why, concretely rather than by default:**

- On-chain indexing (logsSubscribe/webhook on the program ID, parsing fill instructions — the exact pattern `nft-live-feed` uses for ME/Tensor/MMM) is possible in principle once the program ID is known (see §4), and every fill is a real Solana transaction.
- But Jupiter's **own official example app already implements the smart-money-relevant surface** (`/trades` global feed, `/leaderboards`, `/profiles/*` with realized PnL pre-computed) over a **documented, sanctioned REST API** — meaning the hard part (matching fills to wallets, computing realized PnL correctly across buys/sells/settlement/fees) is already solved and maintained by Jupiter, not something this project would need to reverse-engineer from raw instruction data (unlike NFT marketplace programs, which never expose PnL/leaderboard endpoints at all).
- Raw on-chain indexing here would mean independently reconstructing PnL accounting (fees, settlement payouts, position netting) that Jupiter already computes and exposes — significant, error-prone duplicated effort for no clear benefit unless the REST API proves insufficient (rate-limited, laggy, or incomplete) in practice.

**Recommendation**: build MVP entirely on the REST API. Treat Helius/direct on-chain indexing as a **v2 hardening option**, reached for only if real usage reveals a concrete gap the REST API can't cover (e.g., `/trades` misses fills during a burst, or a stricter real-time latency requirement emerges that polling can't meet).

**Update from license research (§7)**: this "v2 hardening" path is not just an engineering option to defer casually — Jupiter's **SDK & API License Agreement**, §3.2(g), restricts combining content obtained through the API with data obtained "through scraping or any other means outside the API." A design that pulls wallet/trade data from the REST API *and* cross-references it against independently-indexed on-chain data (Helius) may fall inside that restriction. This needs a direct answer from Jupiter before it's built, not just a technical feasibility check — see §7 and §12.

---

## 6. Does execution require the Jupiter API?

Yes, for **write** actions (creating/closing orders, claiming payouts) — the API is the only documented way to get the unsigned transaction; there's no published Anchor IDL for constructing these instructions independently. For **read-only** tracking (this project's actual goal), no execution is needed at all — a smart-money tracker never signs or submits anything, it only reads `/trades`, `/history`, `/leaderboards`, `/profiles/*`. Worth stating plainly since it simplifies the security posture: **this project needs no wallet, no keypair, no signing capability whatsoever** for its stated goal.

---

## 7. Access: API key, rate limits, geo-restriction, and terms of use

**No key has been registered.** This section documents the official process and terms only, per explicit instruction — nothing below was created or signed up for automatically.

### 7.1 Where the key is obtained, and whether it's officially required

- Official signup: **`https://developers.jup.ag/portal`** (`portal.jup.ag`). Process per the official setup docs: sign up → create or join a **team** in your organization → generate an API key inside that team. New keys take effect roughly 15 seconds after creation.
- The Prediction-specific developer guide (`developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana`) instructs developers to obtain a key and send it via `x-api-key`, and Jupiter's own example apps always send this header server-side — so the *documented, intended* integration path treats a key as required.
- **Empirically (this project's own probe, `docs/api-probe-results.md`), every read endpoint tested worked with zero API key.** This reconciles cleanly with Jupiter's general platform policy (not Prediction-specific, but the only published number found): **keyless requests across Jupiter's APIs are rate-limited to ~0.5 requests/second**, described as "ideal for testing, prototyping, or AI agent use cases." Our probe's first run (429 after a burst at ~2.5 req/s) and second run (clean at ~0.25 req/s) are consistent with exactly this 0.5 RPS ceiling — the "mystery" rate limit observed in the probe is very likely this documented tier, not something Prediction-specific.
- **Conclusion**: a key is **not strictly required for reads** at low, exploratory volume, but is required in practice for any real polling cadence (the whole point of an ingestion service) and is the officially sanctioned path.

### 7.2 Headers

- `x-api-key: <key>` — authentication.
- `Content-Type: application/json` — on any request with a body (not needed for the GET-only reads this project needs).

### 7.3 Rate limits, with and without a key

No Prediction-API-specific rate-limit numbers were found published separately anywhere. The only published table is Jupiter's general platform pricing (`developers.jup.ag/pricing`), which — per the Prediction dev guide's own instructions to use the same portal/key mechanism — is the best available evidence:

| Plan | Price | Rate limit | Included credits/mo |
|---|---|---|---|
| Keyless (no signup) | — | ~0.5 req/s | — |
| Free | $0/mo | 1 req/s | unlimited usage (community support) |
| Developer | $25/mo | 10 req/s | 25M |
| Launch | $100/mo | 50 req/s | 100M |
| Pro | $500/mo | 150 req/s | 500M |

Overage beyond included credits: roughly $1 per additional million credits. Limits are enforced **per account, not per key** — generating multiple keys under one account does not multiply the rate limit. Windowing: a 60-second sliding window is used for the free tier; other tiers reportedly use a shorter (10-second) window per one source, though this wasn't independently confirmed against Prediction endpoints specifically.

### 7.4 Free / paid / tied to account or domain

Both free and paid tiers exist (table above). Keys are tied to an **account/team**, not to a domain — the portal flow is "create or join a team in your organisation," and rate limits pool at the account level across all keys under it.

### 7.5 Geo-restriction — two different published lists, not fully reconciled

Two distinct restriction lists were found, and they do not match — worth flagging as a discrepancy rather than merging them:

- **Prediction API docs specifically** (`developers.jup.ag/docs/prediction`): blocks **US and South Korea** IPs at the API level; the Jupiter mobile app additionally blocks parts of the EU.
- **General Jupiter Terms of Use** (`developers.jup.ag/docs/misc/terms-of-use`): states Jupiter "does not interact with digital wallets located in, established in, or a resident of the United States, the Republic of China, Singapore, Myanmar (Burma) ... or any other state, country or region that is subject to sanctions enforced by the United States, the United Kingdom or the European Union." VPN use to circumvent this is explicitly prohibited.

These lists overlap (both include the US) but otherwise diverge (South Korea vs. China/Singapore/Myanmar/OFAC-sanctioned regions). Confirm the actual hosting jurisdiction for `vl-trade` against **both** before relying on API access, not just one.

### 7.6 Terms of use for tracking/displaying other wallets' data — real risk, not just an open question

This was the most important thing this research pass changed. Two different Jupiter legal documents apply, and they say different things:

- **General Terms of Use** is largely silent on displaying other users' wallet/trade data specifically — it focuses on non-custodial disclaimers and standard anti-reverse-engineering/IP clauses, plus a liability cap ("the greater of the amount you paid us, or $100").
- **The SDK & API License Agreement** (`developers.jup.ag/docs/misc/sdk-api-license-agreement`) — the document that actually governs API usage — contains several clauses that together create genuine risk for a product whose entire purpose is showing *other* wallets' trade/PnL data to *our* users:
  - **§2.2**: "Licensee shall have no right to distribute, license (whether or not through multiple tiers) or otherwise transfer the API or SDK to any third party."
  - **§3.2(d)**: broadly restricts selling, transferring, or sublicensing "the API, SDK or any content obtained through the API" to third parties.
  - **§3.2(f)**: prohibits using the API "for competitive analysis or disseminate performance information (including uptime, response time and/or benchmarks) relating to the API" — narrower, about the API's own performance, likely not directly blocking this project, but adjacent enough to note.
  - **§3.2(g)**: restricts combining API content with data obtained "through scraping or any other means outside the API" — directly constrains the Helius-as-hardening idea in §5.
  - Affirmative obligations if proceeding regardless: **§2.3** requires correctly/prominently labeling which specific Jupiter API/engine is used; **§8.4** requires prominently displaying "Powered by Jupiter" to end users.

**Caveat on how this was researched**: the quotes above came through an automated fetch-and-summarize tool constrained to short excerpts (~125 characters per quote), not a full verbatim read of the legal text. Treat this as a strong, specific signal that real risk exists — not a substitute for a human reading both documents in full, and not a legal opinion. **Recommendation: ask Jupiter directly (Discord, or the Developer Portal's support channel) whether a public wallet-ranking/trade-tracking product is permitted under these terms before writing any product code** — this is now a harder blocker than the original discovery pass suggested, not just a nice-to-verify item.

---

## 8. Data model proposal

Mirroring the upstream shapes (confirmed field-for-field against Jupiter's own TypeScript types) rather than inventing a parallel schema, so ingestion stays a thin, low-drift mapping:

```
trades                       -- from GET /trades (global feed, primary ingestion source)
  id                 BIGINT PRIMARY KEY   -- upstream id
  action              TEXT                -- 'buy' | 'sell' (upstream: action)
  side                TEXT                -- 'yes' | 'no'
  amount_usd          NUMERIC             -- parsed from micro-USD string
  price_usd           NUMERIC
  owner_pubkey        TEXT                -- wallet — the whole point of this project
  event_id            TEXT
  market_id           TEXT
  event_title         TEXT
  market_title         TEXT
  observed_at          TIMESTAMPTZ        -- our ingestion wall-clock time
  upstream_timestamp   TIMESTAMPTZ        -- upstream: timestamp

history_events                -- from GET /history (richer, has signature/slot/PnL)
  id                  BIGINT PRIMARY KEY
  event_type          TEXT   -- order_created | order_filled | order_failed | payout_claimed | position_updated | position_lost
  signature           TEXT                -- on-chain tx signature — verifiable via RPC/Helius if ever needed
  slot                BIGINT
  owner_pubkey        TEXT
  market_id           TEXT
  position_pubkey     TEXT
  order_pubkey        TEXT
  is_buy              BOOLEAN
  is_yes              BOOLEAN
  avg_fill_price_usd  NUMERIC
  realized_pnl_usd    NUMERIC             -- upstream already computes this
  fee_usd             NUMERIC
  payout_amount_usd   NUMERIC
  event_timestamp     TIMESTAMPTZ

wallet_profiles               -- periodic snapshot from GET /profiles/{pubkey}
  owner_pubkey         TEXT PRIMARY KEY
  realized_pnl_usd     NUMERIC
  total_volume_usd     NUMERIC
  predictions_count    INTEGER
  correct_predictions  INTEGER
  wrong_predictions    INTEGER
  snapshot_at          TIMESTAMPTZ

leaderboard_snapshots          -- periodic snapshot from GET /leaderboards
  owner_pubkey        TEXT
  period              TEXT    -- all_time | weekly | monthly
  rank                INTEGER
  realized_pnl_usd    NUMERIC
  total_volume_usd    NUMERIC
  win_rate_pct        NUMERIC
  snapshot_at         TIMESTAMPTZ
  PRIMARY KEY (owner_pubkey, period, snapshot_at)
```

"Smart money" derivation is then a query over `wallet_profiles`/`leaderboard_snapshots` (high realized PnL, high win rate, sustained volume — thresholds TBD once real data is seen) joined against `trades`/`history_events` for that wallet's live activity — no separate derived-signal table needed for MVP.

---

## 9. Ingestion plan

- **Primary loop**: poll `GET /trades` every 15s (matching Jupiter's own reference cadence — a safe, sanctioned default, not a guess), upsert into `trades` keyed by upstream `id`.
- **Secondary loop**: poll `GET /history` on a slightly longer interval (e.g. 60s) for the richer PnL/signature fields not present in `/trades`, upsert into `history_events` keyed by upstream `id`.
- **Wallet enrichment**: when a wallet's `trades`/`history_events` activity crosses a to-be-tuned size/frequency threshold, fetch `GET /profiles/{ownerPubkey}` (and `pnl-history` if needed) and store a snapshot — not on every trade, to stay well inside the plan's rate limit (§7.3 — e.g. 10 req/s on the $25/mo Developer tier, pooled across all polling loops on the account).
- **Leaderboard loop**: poll `GET /leaderboards` (all three periods) every few minutes as the authoritative, Jupiter-computed ranking — the cheapest, lowest-maintenance path to "who is smart money" without deriving it ourselves.
- **One-time setup step**: call `GET /vault-info`, resolve the returned pubkey's on-chain `.owner` via RPC to record the actual program ID for future reference (documentation, not required for the REST-only MVP itself).
- No websocket/streaming variant of any endpoint was found in official docs or example code — polling is the only demonstrated pattern.

---

## 10. MVP roadmap (phased, mirroring the incremental-validation discipline already established on other projects)

1. **Legal/access verification before any registration** — get a direct answer from Jupiter (§7.6) on whether a public wallet-tracking product is permitted under the SDK & API License Agreement; confirm the current VPS's hosting jurisdiction against both geo-restriction lists (§7.5). Only after that: register for an API key via the Developer Portal, make one authenticated `GET /trades` call, and inspect the real response shape against the types reconstructed here (Jupiter's example-app types are a strong signal, not a guarantee — the API is beta).
2. **Ingestion-only backend** — the two polling loops (`/trades`, `/history`) into Postgres, no analysis yet. Validate against real data for a few days before building anything on top, same discipline used throughout the `nft-live-feed` feature work this thread already went through.
3. **Wallet aggregation** — `/leaderboards` + `/profiles/*` snapshotting, joined against ingested trades.
4. **Smart-money surfacing** — whatever UI/alerting layer comes after the above is validated; explicitly out of scope for this discovery doc.
5. **(Optional, later)** on-chain/Helius indexing only if the REST path proves insufficient in practice (§5).

---

## 11. Risks

- **Beta API, breaking changes** — no version pinning guarantee found; `/forecast`'s loose typing is live evidence this is still moving.
- **Rate limits are now documented at the general-platform level (§7.3), but not confirmed Prediction-specific** — the numbers used for planning are Jupiter's general API pricing table, not a Prediction-API-only guarantee. Key-approval process itself (instant vs. reviewed) still unconfirmed.
- **Geo-restriction — two different lists, not reconciled** (§7.5): Prediction docs say US + South Korea; general ToS says US/China/Singapore/Myanmar/OFAC-sanctioned regions. Must check hosting jurisdiction against both.
- **ToS risk is now concrete, not just uncertain** (§7.6) — the SDK & API License Agreement's §2.2/§3.2(d) (no distributing/transferring API content to third parties) and §3.2(g) (no combining API content with independently-scraped data) directly bear on a product whose purpose is showing other wallets' data to our users, and on the Helius-hardening idea in §5. This is now the **top blocker to resolve before any product code**, escalated from the earlier "open question" framing based on actual clause text (short excerpts, not full verbatim — see §7.6's caveat).
- **Forecast vs Predict conflation** — the two products are intertwined in the same UI/API but differently mature; treating `/forecast` data with the same confidence as the well-typed `/trades`/`/history`/`/leaderboards` endpoints would be a mistake.
- **No published program ID or IDL** — fine for a REST-only MVP, but blocks any future on-chain hardening until derived via the `/vault-info` → `getAccountInfo` step in §4.
- **PnL figures are Jupiter's own computation, not independently verified** — worth spot-checking a few `realized_pnl_usd` values against the underlying `history_events` fills once real data is flowing, before trusting them as the sole "smart money" signal.

---

## 12. Open questions (not resolved by this research)

1. ~~What are the actual rate limits~~ — **answered directionally** by the general Jupiter platform pricing table (§7.3); still open: whether these numbers apply identically to the Prediction API specifically, and whether the Developer Portal approval process is instant or reviewed.
2. **Escalated, not answered**: does the SDK & API License Agreement's §2.2/§3.2(d)/§3.2(g) actually prohibit a public wallet-tracking/leaderboard product? The clause text found (§7.6) is concerning but was read through an automated tool limited to short excerpts — needs either a full human read of both legal documents or a direct answer from Jupiter before proceeding. This is now the highest-priority open question.
3. Is `/history` paginated/bounded in a way that could silently drop data during a burst, and does it fully overlap with `/trades` or carry events `/trades` misses (or vice versa)?
4. What is the actual on-chain program ID (derivable in minutes via §4's `/vault-info` step — this project's own probe already captured the vault pubkey `BrTCoKzZoh7waCM3h2MuJKan8fX2A574gedorgPRC3HJ` in `docs/samples/vault-info.json`; resolving `.owner` via a single `getAccountInfo` call is the only step left, not yet done)?
5. How mature/stable is `/forecast` right now, and should Forecast-sourced markets be excluded from a v1 smart-money signal until better-typed?
6. Which of the two geo-restriction lists (§7.5) actually governs API access vs. just wallet/product usage, and does `vl-trade`'s hosting jurisdiction clear both?

---

## Sources

- https://developers.jup.ag/docs/prediction
- https://developers.jup.ag/docs/guides/how-to-build-a-prediction-market-app-on-solana
- https://docs.jup.ag/user-docs/trade/predict
- https://support.jup.ag/hc/en-us/articles/23089115602716-Prediction-Markets
- https://prediction-market-api.jup.ag/docs
- https://jup.ag/prediction
- https://solanafloor.com/news/jupiter-unveils-forecast-solana-s-first-native-prediction-market
- https://github.com/jup-ag/api-examples (`apps/prediction-markets/lib/api.ts`, `lib/constants.ts`, `hooks/use-social.ts`, `components/trades-feed.tsx`; `apps/prediction-API-video-demo/src/lib/jupiter.ts`, `src/lib/types.ts`, `src/app/api/prediction/[...path]/route.ts`) — fetched directly from `raw.githubusercontent.com`, not from search-result summaries
- https://developers.jup.ag/docs/portal/setup — API key signup process
- https://developers.jup.ag/pricing — plan/rate-limit table
- https://developers.jup.ag/docs/misc/terms-of-use — general Terms of Use
- https://developers.jup.ag/docs/misc/sdk-api-license-agreement — SDK & API License Agreement (the document actually governing API usage; §2.2, §3.2(d)/(f)/(g), §2.3, §8.4 cited in §7.6)
- Probe evidence: `docs/api-probe-results.md` and `docs/samples/*.json` (this project's own read-only API calls, no key used)
