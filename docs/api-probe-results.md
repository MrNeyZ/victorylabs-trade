# Jupiter Prediction API — Probe Results

Ran `scripts/probe-jupiter-prediction.mjs` against `https://api.jup.ag/prediction/v1` — **no API key**, read-only GETs only. Raw responses saved under `docs/samples/`.

## Results

| Endpoint | Status | Auth used | Notes |
|---|---|---|---|
| `GET /trades` | **200** | none | Global trade feed, real live data (Polymarket-sourced BTC/SOL up-down micro-markets at probe time). `id` is a string like `"order-2357524"`, not numeric — data-model note for later. |
| `GET /leaderboards` | **200** | none | Real wallet PnL/win-rate rows. See data-quality note below. |
| `GET /events?includeMarkets=true&start=0&end=5` | **200** | none | Full event metadata incl. rules text, tags, category/subcategory. |
| `GET /profiles/{wallet}` | **200** | none | Wallet discovered live from `/trades`. Matches the shape reconstructed from Jupiter's own example app exactly. |
| `GET /history` (no `ownerPubkey`) | **400** | none | Clean, well-formed error: `"ownerPubkey or userPubkey is required"`. Confirms this endpoint is **not** a global feed — wallet-scoped only. Not a bug, a real constraint. |
| `GET /history?ownerPubkey={wallet}` | **200** | none | Rich per-fill history: real `signature`, `slot`, `orderPubkey`, `positionPubkey`, `keeperPubkey` (empty string in this sample — not always populated, worth watching), `orderId` (long `0x`-prefixed hex string, not a pubkey). |
| `GET /vault-info` | **200** | none | Returns vault PDA pubkey `BrTCoKzZoh7waCM3h2MuJKan8fX2A574gedorgPRC3HJ` plus protocol config (`globalMaxContracts`, `protocolFeeBps`, `tradingDisabled`, etc.) and `vaultBalance` in whole USDC. |
| `GET /markets/{marketId}` | **200** | none | Market discovered live from `/trades`. Full metadata incl. `rulesPrimary` text and provider (`polymarket`). |
| `GET /orderbook/{marketId}` | **200** | none | See discrepancy note below. |

**8 of 9 calls succeeded** on the first clean pass. The one "failure" (`/history` unscoped) is a correctly-documented API constraint, not a broken probe.

## Rate limiting (observed here, now reconciled against Jupiter's documented policy)

The **first** run (400ms between calls, ~2.5 req/s) hit `429 {"code":429,"message":"[API Gateway] Too many requests"}` after roughly 4-5 requests in quick succession. Widening the gap to 4s between calls (~0.25 req/s) produced a clean run with zero 429s.

**Update**: this is not an undocumented mystery limit. Jupiter's general platform docs (`developers.jup.ag/docs/portal/setup`, `developers.jup.ag/pricing` — see `docs/jupiter-prediction-discovery.md` §7.3 for the full table) state keyless requests across Jupiter's APIs are capped at **~0.5 requests/second**. Our two runs bracket that number almost exactly: the 429-triggering run was ~5x over it, the clean run was comfortably under it. Treat 0.5 req/s as the real unauthenticated ceiling for planning purposes, not a guess — and note it's a *general Jupiter platform* number, not confirmed as Prediction-API-specific.

## Two things worth flagging before trusting this data further

1. **Leaderboard data-quality oddity**: at least one `all_time` leaderboard row shows `predictionsCount: 0, correctPredictions: 0, wrongPredictions: 0, winRatePct: "0.00"` alongside a large non-zero `realizedPnlUsd`. Either a real edge case (e.g. a wallet whose PnL derives from something other than counted "predictions" — settlement adjustments, refunds) or a data inconsistency upstream. Not resolved here — worth a second look once more samples are collected over time, before this field is trusted blindly for ranking.
2. **Orderbook shape discrepancy**: the discovery doc (based on Jupiter's own example-app types) described orderbook entries as `[price_cents, size]` tuples. The live sample instead shows keys `1, 2, 3, ... 30` with decreasing size — this reads more like **rank-ordered depth levels** than actual cent-denominated prices. Needs direct comparison against the market's actual YES/NO price range before the data model assumes `[price_cents, size]` literally.

## Answering the task's questions

- **Which endpoints worked?** All 8 read-only calls attempted worked, once past the rate limit. `/history` correctly rejects an unscoped call rather than silently returning nothing.
- **Which failed?** None failed unexpectedly. The only non-200 was the documented `ownerPubkey`-required constraint on `/history`.
- **Is an API key required?** **No — not for any of these read endpoints, and this is now explained rather than just observed.** Every call above succeeded fully unauthenticated, at a rate ceiling matching Jupiter's documented ~0.5 req/s keyless tier (see above). Jupiter's own example app always sends `x-api-key` server-side because that's the *sanctioned production path* (1-150 req/s depending on paid tier — see discovery doc §7.3), not because reads are gated without one. **No key was registered as part of this task, per instruction** — this conclusion is based on documented Jupiter pricing/portal pages plus this probe's own empirical results, not on signing up for anything.
- **Is tracking/displaying other wallets' data actually permitted?** Not answered by this probe (it only tests technical reachability). The discovery doc's §7.6 now documents specific, concerning clauses in Jupiter's SDK & API License Agreement (no third-party redistribution of API content; no combining API data with independently-scraped data) that bear directly on this project's purpose. **Read that section before treating "the data is technically accessible" as "the product is permitted."**
- **Is the data enough for v0.1 smart-money rankings?** **Yes, directionally.** `/leaderboards` already gives ranked wallets by realized PnL/volume/win-rate with zero derivation work on our side. `/profiles/{wallet}` and `/history?ownerPubkey=` add the depth needed to verify and drill into any wallet the leaderboard surfaces. The main open gap is **freshness/coverage of `/trades`** as the discovery mechanism for *new* candidate wallets not yet on the leaderboard — that needs sustained polling over real time to assess, not a single probe run. The rate limit is the real constraint to design around, more than data completeness.

## Files produced

```
docs/samples/trades.json
docs/samples/leaderboards.json
docs/samples/events.json
docs/samples/profiles-wallet.json
docs/samples/history-unscoped.json
docs/samples/history-wallet.json
docs/samples/vault-info.json
docs/samples/markets-marketid.json
docs/samples/orderbook-marketid.json
```

Each file is the raw JSON response wrapped with request metadata (`endpoint`, `status`, `usedApiKey`, `elapsedMs`, `fetchedAt`).
