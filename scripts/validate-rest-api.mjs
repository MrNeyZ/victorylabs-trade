#!/usr/bin/env node
/**
 * Standalone, long-running REST API reliability validation for Jupiter
 * Prediction — Phase 1.9 research only. NOT product code: no DB, no
 * backend/frontend, just a self-contained measurement instrument that logs
 * to flat files under docs/samples/validation/.
 *
 * What this does:
 *   - Polls a fixed set of official endpoints (see SCHEDULE below) on
 *     independent intervals, unauthenticated (no API key was registered —
 *     per explicit instruction from earlier phases).
 *   - Appends one JSONL record per poll to raw-log.jsonl (full fidelity).
 *   - Maintains running integrity/latency stats and checkpoints a summary
 *     JSON every CHECKPOINT_INTERVAL_MS, so partial analysis is always
 *     possible without waiting for the run to finish.
 *   - Detects, for the /trades stream specifically: duplicate IDs within a
 *     single response, IDs that disappear then later reappear (anomalous —
 *     expected behavior for a fixed "last ~20" window is that an ID ages
 *     out and never comes back), reordering of IDs common to consecutive
 *     polls, and numeric-sequence gaps (an ID's numeric suffix skipped
 *     entirely between the oldest and newest IDs ever observed).
 *   - Detects schema-fingerprint changes and malformed objects (missing
 *     required fields per the official OpenAPI spec) on every endpoint.
 *   - Tracks 429/5xx frequency and latency distribution per endpoint.
 *   - Runs for a fixed, hard-capped duration (default ~25h) then exits
 *     cleanly with a final summary — this lets the Bash tool's own
 *     background-completion notification fire naturally instead of
 *     requiring manual polling.
 *   - Also runs fully detached via nohup/setsid so it survives independent
 *     of any single tool-call's process tree.
 *
 * What this does NOT do: no API key, no POST/DELETE, no wallet connect, no
 * signing, no database, no product code of any kind.
 */

import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'docs', 'samples', 'validation');
const RAW_LOG = path.join(OUT_DIR, 'raw-log.jsonl');
const ANOMALY_LOG = path.join(OUT_DIR, 'anomalies.jsonl');
const SUMMARY_FILE = path.join(OUT_DIR, 'summary.json'); // latest cumulative snapshot (overwritten)
const CHECKPOINTS_LOG = path.join(OUT_DIR, 'checkpoints.jsonl'); // time series, one line per checkpoint (appended)
const PID_FILE = path.join(OUT_DIR, 'validate.pid');

const BASE_URL = 'https://api.jup.ag/prediction/v1';
const RUN_DURATION_MS = Number(process.env.VALIDATION_DURATION_MS) || 25 * 60 * 60 * 1000; // ~25h default
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const TIMEOUT_MS = 10_000;

// Known-good wallets carried over from earlier probe samples (leaderboard
// top wallets — chosen for likely-sustained activity across a 24h window).
const TRACKED_WALLETS = [
  '8jqFQXuE5pQ15bhMY6399CqHgYpnEUYkzkZZPdf3w4fB',
  'ArmhM8HaamfqKGWQn2nT9qrT1QD5RGUEdPKqHZi3ft6Z',
];

// Required fields per endpoint, taken directly from the official OpenAPI
// spec's `required` arrays (docs/samples/openapi-spec.json), not guessed.
const REQUIRED_FIELDS = {
  trades: ['id', 'ownerPubkey', 'marketId', 'message', 'timestamp', 'action', 'side', 'eventTitle', 'marketTitle', 'amountUsd', 'priceUsd'],
  leaderboards: ['ownerPubkey', 'realizedPnlUsd', 'totalVolumeUsd', 'predictionsCount', 'correctPredictions', 'wrongPredictions', 'winRatePct', 'period'],
  history: ['id', 'eventType', 'signature', 'slot', 'timestamp', 'marketId', 'ownerPubkey'],
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function now() { return Date.now(); }

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

// ── Global state (in-memory; checkpointed to disk periodically) ─────────────
const state = {
  startedAt: new Date().toISOString(),
  polls: {}, // endpoint -> { count, ok, statusCounts:{}, latencies:[], sizeBytes:[], errors:0 }
  trades: {
    everSeenIds: new Map(),      // id -> { firstSeenPoll, lastSeenPoll, numeric }
    lastPollIds: [],             // ordered (newest-first) ids from the previous poll
    pollIndex: 0,
    duplicateWithinResponse: 0,
    reappearedAfterGone: 0,
    reordered: 0,
    numericGaps: 0,
    freshnessSamplesSec: [],     // per-poll: pollTime - newestTrade.timestamp
    burstSamples: [],            // per-poll: count of newly-seen ids
    malformedRows: 0,
  },
  history: {
    everSeenIds: new Map(),
    duplicateWithinResponse: 0,
    malformedRows: 0,
  },
  schemaFingerprints: {}, // endpoint -> Set of fingerprint strings (first-seen order preserved via array)
  schemaChangeEvents: [],
  rateLimit: { samples: [] }, // {ts, remaining, current, reset}
  status429: 0,
  status5xx: 0,
  totalPolls: 0,
};

async function ensureDirs() {
  await mkdir(OUT_DIR, { recursive: true });
}

async function logAnomaly(type, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, detail }) + '\n';
  await appendFile(ANOMALY_LOG, line).catch(() => {});
}

async function logRaw(record) {
  const line = JSON.stringify(record) + '\n';
  await appendFile(RAW_LOG, line).catch(() => {});
}

function fingerprintOf(obj) {
  if (obj == null || typeof obj !== 'object') return typeof obj;
  return Object.keys(obj).sort().join(',');
}

function recordSchemaFingerprint(endpoint, sampleRow) {
  const fp = fingerprintOf(sampleRow);
  if (!state.schemaFingerprints[endpoint]) state.schemaFingerprints[endpoint] = [];
  const known = state.schemaFingerprints[endpoint];
  if (!known.includes(fp)) {
    const isFirst = known.length === 0;
    known.push(fp);
    if (!isFirst) {
      state.schemaChangeEvents.push({ ts: new Date().toISOString(), endpoint, newFingerprint: fp });
      void logAnomaly('schema_change', { endpoint, fingerprint: fp });
    }
  }
}

function checkMalformed(endpoint, rows, requiredFields) {
  let bad = 0;
  for (const row of rows) {
    if (row == null || typeof row !== 'object') { bad++; continue; }
    for (const f of requiredFields) {
      if (!(f in row) || row[f] == null) { bad++; break; }
    }
  }
  return bad;
}

async function callEndpoint(name, urlPath) {
  const url = `${BASE_URL}${urlPath}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const startedAt = now();
  const bucket = state.polls[name] ??= { count: 0, ok: 0, statusCounts: {}, latencies: [], sizeBytes: [], errors: 0 };
  bucket.count++;
  state.totalPolls++;
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const elapsedMs = now() - startedAt;
    const text = await res.text();
    bucket.latencies.push(elapsedMs);
    bucket.sizeBytes.push(text.length);
    bucket.statusCounts[res.status] = (bucket.statusCounts[res.status] ?? 0) + 1;
    if (res.status === 429) state.status429++;
    if (res.status >= 500) state.status5xx++;
    if (res.ok) bucket.ok++;

    const rl = {
      remaining: res.headers.get('x-ratelimit-remaining'),
      current: res.headers.get('x-ratelimit-current'),
      reset: res.headers.get('x-ratelimit-reset'),
    };
    if (rl.remaining != null) {
      state.rateLimit.samples.push({ ts: now(), endpoint: name, ...rl });
      if (state.rateLimit.samples.length > 2000) state.rateLimit.samples.shift(); // bounded
    }

    let body = null;
    let parseOk = true;
    try { body = JSON.parse(text); } catch { parseOk = false; }

    await logRaw({
      ts: new Date().toISOString(), endpoint: name, status: res.status,
      elapsedMs, sizeBytes: text.length, parseOk, rateLimit: rl,
    });

    return { ok: res.ok, status: res.status, body, parseOk, elapsedMs };
  } catch (err) {
    const elapsedMs = now() - startedAt;
    bucket.errors++;
    bucket.latencies.push(elapsedMs);
    await logRaw({
      ts: new Date().toISOString(), endpoint: name, status: null,
      elapsedMs, error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, status: null, body: null, parseOk: false, elapsedMs, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// ── /trades stream-integrity check ───────────────────────────────────────────
async function pollTrades() {
  const t = state.trades;
  t.pollIndex++;
  const res = await callEndpoint('trades', '/trades');
  if (!res.ok || !res.body) return;

  const rows = Array.isArray(res.body?.data) ? res.body.data : [];
  if (rows.length > 0) recordSchemaFingerprint('trades', rows[0]);
  t.malformedRows += checkMalformed('trades', rows, REQUIRED_FIELDS.trades);

  // Duplicate IDs WITHIN this single response (a real bug if it happens —
  // not the expected same-id-across-consecutive-polls overlap).
  const idsThisPoll = rows.map((r) => r.id);
  const seenThisPoll = new Set();
  for (const id of idsThisPoll) {
    if (seenThisPoll.has(id)) {
      t.duplicateWithinResponse++;
      void logAnomaly('duplicate_within_response', { endpoint: 'trades', id });
    }
    seenThisPoll.add(id);
  }

  // Burst + freshness (based on the newest row — rows are newest-first per
  // observed live behavior, confirmed in earlier probe samples).
  let newCount = 0;
  for (const id of idsThisPoll) {
    if (!t.everSeenIds.has(id)) newCount++;
  }
  t.burstSamples.push(newCount);
  if (rows.length > 0 && typeof rows[0].timestamp === 'number') {
    const freshnessSec = Date.now() / 1000 - rows[0].timestamp;
    t.freshnessSamplesSec.push(freshnessSec);
  }

  // Disappear-then-reappear + numeric-gap tracking.
  for (const id of idsThisPoll) {
    const prior = t.everSeenIds.get(id);
    if (prior && t.pollIndex - prior.lastSeenPoll > 1) {
      // Was seen before, absent for at least one full poll cycle, now back.
      t.reappearedAfterGone++;
      void logAnomaly('reappeared_after_gone', { id, gapPolls: t.pollIndex - prior.lastSeenPoll });
    }
    const numMatch = typeof id === 'string' ? id.match(/(\d+)$/) : null;
    const numeric = numMatch ? parseInt(numMatch[1], 10) : null;
    if (!prior) {
      t.everSeenIds.set(id, { firstSeenPoll: t.pollIndex, lastSeenPoll: t.pollIndex, numeric });
    } else {
      prior.lastSeenPoll = t.pollIndex;
    }
  }

  // Reordering: among IDs common to this poll and the previous poll, is
  // their relative order preserved?
  if (t.lastPollIds.length > 0) {
    const prevIndex = new Map(t.lastPollIds.map((id, i) => [id, i]));
    const common = idsThisPoll.filter((id) => prevIndex.has(id));
    for (let i = 1; i < common.length; i++) {
      if (prevIndex.get(common[i]) < prevIndex.get(common[i - 1])) {
        t.reordered++;
        void logAnomaly('reordered', { a: common[i - 1], b: common[i] });
        break; // one flag per poll is enough signal
      }
    }
  }
  t.lastPollIds = idsThisPoll;

  // NOTE on the numeric suffix in trade `id` (e.g. "order-2357524"): this is
  // a SHARED, platform-wide counter across order/position/ticket event
  // types, not a trades-only sequence (confirmed empirically — the raw
  // numeric range between consecutively-observed trade ids is far larger
  // than the trade count between them, even over a few seconds). A naive
  // "missing integer in the range" gap count is therefore NOT a valid
  // missed-trade signal and is deliberately not computed as one. Recorded
  // instead, honestly, as span/density only (see numericIdSpan below) plus
  // a real proxy for likely misses: fullWindowBurst (below).
  const numerics = [...t.everSeenIds.values()].map((v) => v.numeric).filter((n) => n != null);
  if (numerics.length > 1) {
    t.numericGaps = { min: Math.min(...numerics), max: Math.max(...numerics), distinctTradesSeen: numerics.length };
  }

  // Better proxy for "did we likely miss trades between polls": if EVERY
  // row in a poll is newly-seen (the whole ~20-row window turned over since
  // last poll), some trades that existed briefly between this poll and the
  // last may have been pushed out of the window before we ever saw them.
  if (rows.length > 0 && newCount === rows.length) {
    t.fullWindowBurstCount = (t.fullWindowBurstCount ?? 0) + 1;
    void logAnomaly('full_window_burst_possible_miss', { pollIndex: t.pollIndex, rowCount: rows.length });
  }
}

async function pollHistoryForWallet(wallet) {
  const res = await callEndpoint('history', `/history?ownerPubkey=${wallet}`);
  if (!res.ok || !res.body) return;
  const rows = Array.isArray(res.body?.data) ? res.body.data : [];
  if (rows.length > 0) recordSchemaFingerprint('history', rows[0]);
  state.history.malformedRows += checkMalformed('history', rows, REQUIRED_FIELDS.history);
  const seenThisPoll = new Set();
  for (const r of rows) {
    if (seenThisPoll.has(r.id)) state.history.duplicateWithinResponse++;
    seenThisPoll.add(r.id);
    state.history.everSeenIds.set(r.id, true);
  }
}

async function pollLeaderboards() {
  const res = await callEndpoint('leaderboards', '/leaderboards');
  if (!res.ok || !res.body) return;
  const rows = Array.isArray(res.body?.data) ? res.body.data : [];
  if (rows.length > 0) recordSchemaFingerprint('leaderboards', rows[0]);
}

async function pollHeartbeat() {
  await callEndpoint('trading-status', '/trading-status');
}

async function pollVaultInfo() {
  await callEndpoint('vault-info', '/vault-info');
}

function summarize() {
  const perEndpoint = {};
  for (const [name, b] of Object.entries(state.polls)) {
    const sorted = [...b.latencies].sort((x, y) => x - y);
    perEndpoint[name] = {
      polls: b.count,
      ok: b.ok,
      uptimePct: b.count > 0 ? Number(((b.ok / b.count) * 100).toFixed(2)) : null,
      errors: b.errors,
      statusCounts: b.statusCounts,
      avgLatencyMs: sorted.length ? Math.round(sorted.reduce((a, c) => a + c, 0) / sorted.length) : null,
      p95LatencyMs: percentile(sorted, 0.95),
      p99LatencyMs: percentile(sorted, 0.99),
      maxLatencyMs: sorted.length ? sorted[sorted.length - 1] : null,
      avgResponseBytes: b.sizeBytes.length ? Math.round(b.sizeBytes.reduce((a, c) => a + c, 0) / b.sizeBytes.length) : null,
    };
  }

  const freshArr = state.trades.freshnessSamplesSec;
  const burstArr = state.trades.burstSamples;
  const elapsedMin = (now() - Date.parse(state.startedAt)) / 60000;

  return {
    generatedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    elapsedMinutes: Number(elapsedMin.toFixed(1)),
    totalPolls: state.totalPolls,
    status429: state.status429,
    status5xx: state.status5xx,
    perEndpoint,
    trades: {
      distinctIdsSeen: state.trades.everSeenIds.size,
      duplicateWithinResponse: state.trades.duplicateWithinResponse,
      reappearedAfterGone: state.trades.reappearedAfterGone,
      reordered: state.trades.reordered,
      numericIdSpan: state.trades.numericGaps ?? null,
      fullWindowBurstCount: state.trades.fullWindowBurstCount ?? 0,
      malformedRows: state.trades.malformedRows,
      avgFreshnessSec: freshArr.length ? Number((freshArr.reduce((a, c) => a + c, 0) / freshArr.length).toFixed(1)) : null,
      maxObservedDelaySec: freshArr.length ? Number(Math.max(...freshArr).toFixed(1)) : null,
      avgBurstNewPerPoll: burstArr.length ? Number((burstArr.reduce((a, c) => a + c, 0) / burstArr.length).toFixed(2)) : null,
      maxObservedBurst: burstArr.length ? Math.max(...burstArr) : null,
      avgTradesPerMinute: elapsedMin > 0 ? Number((state.trades.everSeenIds.size / elapsedMin).toFixed(2)) : null,
    },
    history: {
      distinctIdsSeen: state.history.everSeenIds.size,
      duplicateWithinResponse: state.history.duplicateWithinResponse,
      malformedRows: state.history.malformedRows,
    },
    schemaChangeEvents: state.schemaChangeEvents,
    rateLimitSampleCount: state.rateLimit.samples.length,
    rateLimitRecentSamples: state.rateLimit.samples.slice(-10),
  };
}

async function checkpoint() {
  const summary = summarize();
  await writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2)).catch(() => {});
  // Append a compact time-series record too, so latency/uptime/trades-per-
  // minute trends over the full run can be plotted later, not just the
  // final cumulative snapshot.
  const compact = {
    ts: summary.generatedAt,
    elapsedMinutes: summary.elapsedMinutes,
    totalPolls: summary.totalPolls,
    status429: summary.status429,
    status5xx: summary.status5xx,
    tradesAvgLatencyMs: summary.perEndpoint.trades?.avgLatencyMs ?? null,
    tradesP95LatencyMs: summary.perEndpoint.trades?.p95LatencyMs ?? null,
    tradesUptimePct: summary.perEndpoint.trades?.uptimePct ?? null,
    distinctTradeIdsSeen: summary.trades.distinctIdsSeen,
    avgTradesPerMinute: summary.trades.avgTradesPerMinute,
    avgFreshnessSec: summary.trades.avgFreshnessSec,
    maxObservedDelaySec: summary.trades.maxObservedDelaySec,
    reappearedAfterGone: summary.trades.reappearedAfterGone,
    reordered: summary.trades.reordered,
    fullWindowBurstCount: summary.trades.fullWindowBurstCount,
  };
  await appendFile(CHECKPOINTS_LOG, JSON.stringify(compact) + '\n').catch(() => {});
  console.log(`[validate] checkpoint @ ${summary.generatedAt} — polls=${summary.totalPolls} trades_seen=${summary.trades.distinctIdsSeen} 429s=${summary.status429} 5xx=${summary.status5xx}`);
}

async function main() {
  await ensureDirs();
  await writeFile(PID_FILE, String(process.pid));
  console.log(`[validate] starting. pid=${process.pid} duration_ms=${RUN_DURATION_MS} out_dir=${OUT_DIR}`);

  const endAt = now() + RUN_DURATION_MS;
  let lastCheckpoint = now();

  // Independent interval loops, each self-scheduling with setTimeout (not
  // setInterval) so a slow request never causes overlapping calls to pile up.
  const loops = [
    { fn: pollTrades, intervalMs: 15_000, nextAt: now() },
    { fn: pollHeartbeat, intervalMs: 60_000, nextAt: now() + 2_000 },
    { fn: pollLeaderboards, intervalMs: 120_000, nextAt: now() + 4_000 },
    { fn: () => pollHistoryForWallet(TRACKED_WALLETS[0]), intervalMs: 120_000, nextAt: now() + 6_000 },
    { fn: () => pollHistoryForWallet(TRACKED_WALLETS[1]), intervalMs: 120_000, nextAt: now() + 8_000 },
    { fn: pollVaultInfo, intervalMs: 600_000, nextAt: now() + 10_000 },
  ];

  while (now() < endAt) {
    const t = now();
    for (const loop of loops) {
      if (t >= loop.nextAt) {
        loop.nextAt = t + loop.intervalMs;
        try { await loop.fn(); } catch (err) { console.error('[validate] loop error', err); }
      }
    }
    if (now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS) {
      lastCheckpoint = now();
      await checkpoint();
    }
    await sleep(1000);
  }

  await checkpoint();
  console.log('[validate] duration elapsed — final summary written, exiting cleanly.');
  process.exit(0);
}

process.on('unhandledRejection', (err) => console.error('[validate] unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('[validate] uncaughtException', err));
process.on('SIGTERM', async () => { console.log('[validate] SIGTERM — writing final checkpoint'); await checkpoint(); process.exit(0); });
process.on('SIGINT', async () => { console.log('[validate] SIGINT — writing final checkpoint'); await checkpoint(); process.exit(0); });

main().catch((err) => { console.error('[validate] fatal', err); process.exit(1); });
