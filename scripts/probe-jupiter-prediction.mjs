#!/usr/bin/env node
/**
 * Read-only probe of Jupiter Prediction's public REST API
 * (https://api.jup.ag/prediction/v1) — Phase 1 discovery only.
 *
 * What this does:
 *   - Calls a fixed list of GET endpoints identified in
 *     docs/jupiter-prediction-discovery.md.
 *   - Logs status code + timing for each.
 *   - Saves the raw JSON (or raw text, if not JSON) response to
 *     docs/samples/<name>.json, wrapped with request metadata.
 *   - Discovers a real wallet pubkey + marketId from /trades so
 *     /profiles/{wallet} and /markets/{marketId} can be probed for real.
 *
 * What this does NOT do (by design, per task scope):
 *   - No API key required or assumed — set JUPITER_API_KEY in the
 *     environment to test authenticated calls; every call runs
 *     unauthenticated otherwise, which is itself the thing being tested.
 *   - No POST/DELETE (no order creation, no position changes, no claims).
 *   - No wallet connect, no signing, no keypair anywhere in this file.
 *   - No database, no Helius, no on-chain RPC calls.
 *
 * Usage: node scripts/probe-jupiter-prediction.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(__dirname, '..', 'docs', 'samples');
const BASE_URL = 'https://api.jup.ag/prediction/v1';
const API_KEY = process.env.JUPITER_API_KEY || null;
const TIMEOUT_MS = 10_000;
const DELAY_BETWEEN_CALLS_MS = 4000; // widened after hitting 429 on first run

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One GET call. Never throws — failures are captured in the returned record. */
async function callEndpoint(name, pathAndQuery) {
  const url = `${BASE_URL}${pathAndQuery}`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const elapsedMs = Date.now() - startedAt;
    const text = await res.text();
    let body = text;
    let parsed = false;
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      /* non-JSON response body — kept as raw text */
    }
    return {
      name,
      path: pathAndQuery,
      url,
      status: res.status,
      ok: res.ok,
      elapsedMs,
      parsedAsJson: parsed,
      usedApiKey: Boolean(API_KEY),
      error: null,
      body,
    };
  } catch (err) {
    return {
      name,
      path: pathAndQuery,
      url,
      status: null,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      parsedAsJson: false,
      usedApiKey: Boolean(API_KEY),
      error: err instanceof Error ? err.message : String(err),
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function saveSample(result) {
  await mkdir(SAMPLES_DIR, { recursive: true });
  const file = path.join(SAMPLES_DIR, `${result.name}.json`);
  const payload = {
    endpoint: result.path,
    url: result.url,
    status: result.status,
    ok: result.ok,
    usedApiKey: result.usedApiKey,
    parsedAsJson: result.parsedAsJson,
    elapsedMs: result.elapsedMs,
    fetchedAt: new Date().toISOString(),
    error: result.error,
    body: result.body,
  };
  await writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

/** Best-effort wallet pubkey extraction from a /trades or /leaderboards body. */
function extractFirstWallet(body) {
  const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!arr || arr.length === 0) return null;
  for (const row of arr) {
    const w = row?.ownerPubkey ?? row?.owner ?? row?.wallet;
    if (typeof w === 'string' && w.length > 0) return w;
  }
  return null;
}

/** Best-effort marketId extraction from a /trades body. */
function extractFirstMarketId(body) {
  const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!arr || arr.length === 0) return null;
  for (const row of arr) {
    if (typeof row?.marketId === 'string' && row.marketId.length > 0) return row.marketId;
  }
  return null;
}

async function run(name, pathAndQuery) {
  const result = await callEndpoint(name, pathAndQuery);
  console.log(
    `[probe] GET ${pathAndQuery} -> ${result.status ?? 'ERROR: ' + result.error} ` +
    `(${result.elapsedMs}ms, key=${result.usedApiKey ? 'yes' : 'no'})`,
  );
  await saveSample(result);
  await sleep(DELAY_BETWEEN_CALLS_MS);
  return result;
}

async function main() {
  console.log(`[probe] base=${BASE_URL} apiKey=${API_KEY ? 'present (will send x-api-key)' : 'ABSENT (unauthenticated calls only)'}`);
  const results = [];

  // 1. Global trade feed — no wallet needed, primary discovery source.
  const trades = await run('trades', '/trades');
  results.push(trades);

  // 2. Leaderboards — no wallet needed.
  const leaderboards = await run('leaderboards', '/leaderboards');
  results.push(leaderboards);

  // 3. Documented markets/events endpoint.
  const events = await run('events', '/events?includeMarkets=true&start=0&end=5');
  results.push(events);

  // 4. Discover a real wallet + marketId from whichever call actually returned data.
  const wallet =
    extractFirstWallet(trades.body) ??
    extractFirstWallet(leaderboards.body);
  const marketId = extractFirstMarketId(trades.body);

  console.log(`[probe] discovered wallet: ${wallet ?? 'NONE'}`);
  console.log(`[probe] discovered marketId: ${marketId ?? 'NONE'}`);

  // 5. /profiles/{wallet} — only if a wallet was actually obtained.
  if (wallet) {
    results.push(await run('profiles-wallet', `/profiles/${wallet}`));
  } else {
    console.log('[probe] SKIP /profiles/{wallet} — no wallet pubkey available from /trades or /leaderboards');
    results.push({ name: 'profiles-wallet', path: '/profiles/{wallet}', status: 'SKIPPED', ok: false, skippedReason: 'no wallet available' });
  }

  // 6. /history — try unscoped first (no ownerPubkey), then wallet-scoped if we have one.
  results.push(await run('history-unscoped', '/history'));
  if (wallet) {
    results.push(await run('history-wallet', `/history?ownerPubkey=${wallet}`));
  } else {
    console.log('[probe] SKIP /history?ownerPubkey= — no wallet pubkey available');
    results.push({ name: 'history-wallet', path: '/history?ownerPubkey={wallet}', status: 'SKIPPED', ok: false, skippedReason: 'no wallet available' });
  }

  // 7. /vault-info
  results.push(await run('vault-info', '/vault-info'));

  // 8. /markets/{marketId} — only if we found one.
  if (marketId) {
    results.push(await run('markets-marketid', `/markets/${encodeURIComponent(marketId)}`));
    results.push(await run('orderbook-marketid', `/orderbook/${encodeURIComponent(marketId)}`));
  } else {
    console.log('[probe] SKIP /markets/{marketId} and /orderbook/{marketId} — no marketId available from /trades');
    results.push({ name: 'markets-marketid', path: '/markets/{marketId}', status: 'SKIPPED', ok: false, skippedReason: 'no marketId available' });
    results.push({ name: 'orderbook-marketid', path: '/orderbook/{marketId}', status: 'SKIPPED', ok: false, skippedReason: 'no marketId available' });
  }

  return results;
}

main()
  .then((results) => {
    console.log('\n[probe] DONE — summary:');
    for (const r of results) {
      console.log(`  ${r.name.padEnd(20)} status=${r.status ?? 'ERR'}  ok=${r.ok}`);
    }
  })
  .catch((err) => {
    console.error('[probe] fatal error', err);
    process.exit(1);
  });
