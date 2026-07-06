# Jupiter Prediction REST API — 24h+ Reliability Validation

Status: **FINALIZED — research only. No product code, no backend, no frontend, no database, no git init, no commits were created for this phase.**

| | |
|---|---|
| Script | `scripts/validate-rest-api.mjs` |
| Started (UTC) | `2026-07-05T12:35:30.841Z` |
| Stopped (UTC) | `2026-07-06T12:59:44.974Z` |
| **Actual runtime** | **24h 24m (24.40 hours)** — exceeds the requested 23h+ minimum |
| Stop method | Clean `SIGTERM` (not the script's own 25h auto-exit) — sent once elapsed runtime was confirmed ≥23h. The handler wrote a final checkpoint before exiting; confirmed via `stdout.log`'s last two lines: `[validate] SIGTERM — writing final checkpoint` / `[validate] checkpoint @ 2026-07-06T12:59:44.974Z — polls=9525 trades_seen=6221 429s=8 5xx=0`. Process confirmed no longer running (`ps -p <pid>` → empty) after stop. |
| Process | Ran fully detached (`setsid`+`nohup`+`disown`, `PPID=1`) for the entire window — never depended on any single session. |
| Data sources used | `docs/samples/validation/summary.json` (final cumulative snapshot), `checkpoints.jsonl` (293 time-series rows, one per 5 min, 0 resets/restarts detected), `anomalies.jsonl` (38 lines total), `raw-log.jsonl` (1,735,984 bytes — per-poll status/latency/size/rate-limit metadata, used to independently cross-check latency and status-code figures below) |

---

## 1. Methodology (unchanged from the pre-registered plan)

Endpoints polled, all unauthenticated:

| Endpoint | Interval | Rationale |
|---|---|---|
| `/trades` | 15s | Matches Jupiter's own reference-app polling cadence — primary target for stream-integrity checks. |
| `/trading-status` | 60s | Cheapest heartbeat for uptime/latency baseline. |
| `/leaderboards` | 120s | Health + schema-stability check on a heavier payload. |
| `/history?ownerPubkey=` (×2 wallets) | 120s each | Same integrity checks on a second, genuinely-paginated endpoint. |
| `/vault-info` | 600s | Rarely changes; cheap schema-stability tripwire. |

Detection logic (as implemented, not just described) is unchanged from the original plan — see the prior version of this file in git-free history / the script's own header comment for full detail on duplicate/reorder/burst/schema-drift definitions. One caveat carried over faithfully: the trade `id`'s numeric suffix is a platform-wide shared counter (not a trades-only sequence), so "missing integer in range" was never used as a loss metric — only span, plus the **full-window-burst** proxy, is reported.

**Data-fidelity note (read before trusting the integrity numbers below):** `raw-log.jsonl` stores per-poll *metadata only* (timestamp, status, latency, response size, rate-limit headers) — it does **not** store full response bodies. That means latency/status/uptime figures below were independently re-derived from `raw-log.jsonl` and matched the daemon's own `summary.json` exactly (reported below). Trade-*content* metrics (duplicate IDs, malformed rows, burst counts, freshness, reappearance) could **not** be independently re-derived after the fact — they exist only as the daemon's own in-process computation, checkpointed to `summary.json`/`checkpoints.jsonl`/`anomalies.jsonl` as the run progressed. This is disclosed rather than glossed over; there is no evidence of a discrepancy (checkpoint history is monotonic with zero resets across all 293 samples, which is the strongest available consistency check), but "independently re-verified from raw bytes" is only true for the latency/status numbers, not the trade-integrity numbers.

---

## 2. Uptime & latency, per endpoint (from `summary.json.perEndpoint`, cross-checked against `raw-log.jsonl` for `/trades`)

| Endpoint | Polls | Success | Uptime | 429s | 5xx | Avg latency | p95 | p99 | Max |
|---|---|---|---|---|---|---|---|---|---|
| `/trades` | 5,738 | 5,736 | 99.97% | 2 | 0 | 197 ms | 262 ms | 535 ms | 3,964 ms |
| `/trading-status` | 1,452 | 1,451 | 99.93% | 1 | 0 | 134 ms | 149 ms | 318 ms | 2,910 ms |
| `/leaderboards` | 730 | 730 | 100% | 0 | 0 | 234 ms | 477 ms | 2,288 ms | 4,615 ms |
| `/history` | 1,458 | 1,453 | 99.66% | 5 | 0 | 234 ms | 453 ms | 779 ms | 2,619 ms |
| `/vault-info` | 147 | 147 | 100% | 0 | 0 | 193 ms | 334 ms | 747 ms | 1,011 ms |
| **Total** | **9,525** | **9,517** | **99.92%** | **8** | **0** | — | — | — | — |

`/trades` latency was independently recomputed directly from `raw-log.jsonl`'s 5,736 successful entries: avg 197.29 ms, p95 262 ms, p99 535 ms, max 3,964 ms, min 142 ms — an exact match to the daemon's own `summary.json`.

**Overall success rate: 9,517 / 9,525 = 99.92%.** Zero request-level errors (network/timeout) on any endpoint across the full run — the only non-200 responses were the 8 rate-limit (429) responses. **Zero 5xx responses on any endpoint, over 9,525 requests and 24.4 hours.**

---

## 3. Trade-stream integrity over the full window

- **Trades observed (distinct trade IDs seen):** 6,221
- **Numeric ID span:** 71,141 → 2,395,001 (confirms this counter is shared platform-wide across order/position/ticket types — span is ~2.3M for ~6,221 distinct trades seen, i.e. not usable as a gap-count; reported as span only, per the pre-registered caveat)
- **Duplicate IDs within a single response:** 0 (0 across 5,736 successful `/trades` polls)
- **Reordering events:** 0 (across all polls where a previous poll existed to compare against)
- **Malformed rows** (`/trades`): 0. **Malformed rows** (`/history`): 0.
- **Schema-change events, any endpoint:** 0 (`schemaChangeEvents: []` — no fingerprint drift detected on any of the 5 endpoints for the full 24.4h)
- **Disappeared-then-reappeared IDs:** 37 total — but this number needs the following correction, found by tracing `anomalies.jsonl` against `raw-log.jsonl` rather than taken at face value:
  - All 37 events have `gapPolls: 2` (the minimum possible — one skipped poll cycle, not a sustained gap).
  - They cluster into exactly **two discrete incidents** (18 events at `2026-07-05T12:45:59Z`, 19 events at `2026-07-05T22:26:36–37Z`), not spread evenly across the day.
  - Cross-referencing `raw-log.jsonl` at both timestamps: **both incidents are immediately preceded by a `429` response on `/trades`** (`12:45:43.562Z → 429`, `22:26:21.726Z → 429`), each skipping exactly one 15s poll cycle before the next successful poll returned the same window, now flagged as "reappeared" relative to the skipped cycle.
  - **Conclusion: all 37 reappearance events are fully explained by the 2 rate-limit-induced skipped polls on `/trades` specifically — not by any genuine API-side reordering, caching inconsistency, or data-integrity bug.** No trade ID reappeared after a gap longer than one skipped cycle, and no ID was ever permanently lost then resurfaced.

---

## 4. Trade velocity, burst, and freshness

- **Average trades/minute (24.4h):** 4.25. *(Note: an earlier smoke-test observation in a since-superseded draft of this document estimated 35–60 trades/min from a ~35-second sample. The full-window figure — 6,221 distinct trades across 1,464 minutes — is the reliable number; the smoke-test estimate was a burst artifact of an unrepresentatively small sample and should be disregarded.)*
- **Average new-IDs-per-poll ("burst"):** 1.08, against a ~20-row window — i.e. steady-state polls overlap ~95% with the previous poll, a wide safety margin at 15s intervals.
- **Maximum observed burst (new IDs in one poll):** 20 (full window). This occurred at **poll #1 of the entire run** — the very first poll, where the "already seen" set is empty by construction, so a 100%-new result is trivially guaranteed and not evidence of anything. This is directly confirmed by `checkpoints.jsonl`: `fullWindowBurstCount` was already `1` at the very first checkpoint (5 minutes in) and **never incremented again for the remaining ~24.3 hours** across all 292 subsequent checkpoints.
- **Full `/trades` window turnovers, excluding the trivial startup poll: 0 in ~24.3 hours of steady-state polling.** The true second-highest burst size in the remaining ~9,499 polls was not separately recorded (only the running max/avg were persisted), but it is upper-bounded at 19-of-20 by definition, since `fullWindowBurstCount` did not increment again.
- **Average freshness** (poll time − newest trade timestamp): 22s, stable throughout the run (checkpoint-level average ranged 18.5s–31s, no degrading trend).
- **Maximum observed freshness delay:** 240.6s (~4 minutes), reached via 5 discrete step-increases spread across the entire window (at elapsed 5, 35, 200, 1,102, and 1,317 minutes — i.e. roughly once every several hours), each only modestly above the last (72s → 105s → 160s → 201s → 241s), then flat for the final ~147 minutes with no new record. Reads as isolated low-trade-volume moments, not sustained degradation or a growing backlog.

---

## 5. 429 / 5xx frequency

- **Total 429s: 8** over 9,525 requests (0.084%) — broken down: `/trades` 2, `/trading-status` 1, `/history` 5, `/leaderboards` 0, `/vault-info` 0.
- **Total 5xx: 0** — none, on any endpoint, over the full 24.4h.
- **Correlation with time-of-day:** not concentrated in any particular hour (429s are spread across the run per `rateLimitRecentSamples` and the two reappearance-incident timestamps 12 hours apart); no burst-of-429s event that would suggest a sustained rate-limit breach — consistent with the combined polling rate staying comfortably under the documented ~5-requests-per-4s envelope.
- **Consequence of the 429s observed:** zero permanent data loss traced back to any of the 8 events — the two 429s that hit `/trades` produced the reappearance pattern explained in §3 (a same-cycle retry-on-next-poll recovers fully); the daemon has no explicit 429 retry logic, and none was needed, since the next scheduled poll 15s later always succeeded.

---

## 6. Whether 15-second polling of `/trades` was sufficient

**Yes**, supported by four independent signals from the same 24.4h window:

1. **Zero non-trivial full-window turnovers** — the `/trades` ~20-row window never fully rotated between two consecutive 15s polls, except at the guaranteed-trivial very first poll.
2. **Low steady-state overlap pressure** — average burst of 1.08 new IDs per poll against a 20-row window is a wide margin, consistent with the low observed trade rate (4.25/min ⇒ a 20-row window holds roughly 4–5 minutes of trade history at the average pace, ~16–20× the 15s interval).
3. **The only anomalies traced to a root cause (429-induced skipped polls) self-healed on the very next scheduled poll** — no ID was permanently lost during either of the two skip incidents.
4. **No degrading trend across the full window** — latency, freshness, and burst all stayed flat across 293 checkpoints; this was a stable-state result, not one saved by a lucky quiet period followed by a worsening tail.

Caveat carried over from `docs/rest-api-capabilities.md` (not re-litigated here, still true): `/trades` itself has no true pagination/cursor — this validation confirms it *behaved* reliably at 15s cadence for a full day, not that it structurally *guarantees* completeness the way `/history` (which is genuinely paginated) does. The recommendation below reflects that distinction.

---

## 7. Final verdict

### **A) REST API is safe enough for MVP system of record** — with one specific architectural condition carried over from the capabilities research, not a new hedge invented here:

- Use `/trades` at 15s polling as the live, "feels real-time" presentation layer — 24.4h of continuous evidence shows 0 non-trivial full-window turnovers, 0 duplicates, 0 reordering, 0 malformed rows, 0 schema drift, 0 5xx, and a 99.92% raw success rate with the only failures (8×429, 0.084%) self-healing within one 15s cycle with no observed permanent loss.
- Use `/history` (genuinely paginated, per the OpenAPI spec) as the completeness/reconciliation source for any accounting-sensitive logic, rather than relying on `/trades`' fixed-size window as a structural completeness guarantee — this is a design choice supported by the endpoint's own shape, not a finding of a problem in the data collected.

This is not verdict (B): nothing in 24.4 hours of stable, trend-free data suggests more time would change the conclusion — the two real anomalies found have a confirmed, benign root cause (rate-limit-induced skipped polls, both self-healing), not an open question. It is not verdict (C): there is no 5xx, no schema drift, no unrecovered data loss, and no sustained degradation anywhere in the dataset.

---

## Appendix — where every number above came from

1. `docs/samples/validation/summary.json` — final cumulative snapshot at stop time, all per-endpoint and trade-integrity figures.
2. `docs/samples/validation/checkpoints.jsonl` — 293 rows, one per 5 minutes, used to confirm no resets/restarts (monotonic `totalPolls`), and to trace the timing of freshness-delay step-increases and the `fullWindowBurstCount` staying at 1 from the first checkpoint onward.
3. `docs/samples/validation/anomalies.jsonl` — 38 lines total (37 `reappeared_after_gone` + 1 `full_window_burst_possible_miss`), individually inspected and cross-referenced against `raw-log.jsonl` to establish the 429-correlation root cause in §3.
4. `docs/samples/validation/raw-log.jsonl` — used to independently recompute `/trades` latency/status distribution (exact match to `summary.json`) and to pull the specific request outcomes at both reappearance-incident timestamps.

No product code, database, backend, frontend, git repository, or commits were created as part of this phase — only the pre-existing validation script was run to completion and this document was updated from its output.
