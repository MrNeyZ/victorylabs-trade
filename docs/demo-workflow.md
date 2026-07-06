# Demo Workflow

Phase 4.4. A repeatable, bounded sequence for going from an empty
database to a demo-ready MVP: real ingested data, computed Smart Scores,
persisted Smart Money Signals, and both the backend and frontend running
— the exact loop used to verify every phase in this project, now
captured as one command instead of re-derived by hand each time.

This does not replace `README.md` §6 (the general local dev flow) — it's
a stricter, opinionated version of it specifically for demoing: same
underlying jobs, no ambiguity about order or flags.

---

## 1. Prerequisites

Same as `README.md` §4/§5: Node.js ≥22, a local Postgres instance, a
`.env` with `DATABASE_URL` set. **Nothing upstream-destructive happens**
— every job here is read-only against Jupiter and either idempotent or
additive against your own database (see §6). You do not need a fresh
database to run this; a pre-existing one just accumulates more data.

## 2. The one-command version

```bash
npm run demo:prepare
```

This runs, in order, and **exits on its own** (bounded — no loop, no
daemon, no polling job):

```jsonc
db:migrate                 // apply schema (idempotent)
  → ingest:trades:once      // one poll of the live /trades feed (~20 trades)
  → ingest:rankings         // leaderboards + top-20 wallet profiles
  → ingest:positions:recent // positions for up to 5 recently-active wallets
  → ingest:history:recent   // history for the same up-to-5 wallets
  → analytics:scores        // Smart Score every candidate wallet
  → analytics:signals:persist  // detect + persist Smart Money Signals
```

The last step intentionally passes non-default flags —
`--lookbackMinutes=1440 --minSmartScore=1 --whaleUsd=15 --consensusWallets=2`
— instead of `analytics:signals:persist`'s production defaults
(`lookbackMinutes=60`, `minSmartScore=35`, `whaleUsd=1000`,
`consensusWallets=3`). **This is not a scoring formula change** — it's
the same CLI override surface `persistSmartMoneySignals.ts` has always
supported (see its own header comment), pointed at looser thresholds so
a small, freshly-ingested demo dataset (tens of trades, no wallet with
real trading history yet) actually produces visible signals instead of
three empty dashboard cards. Nothing about `detectSmartMoneySignals.ts`,
`computeWalletScore.ts`, or any other scoring/formula file changes.

Once it finishes, start the backend and frontend yourself, each in its
own terminal (matching README §6 — these are meant to be left running,
not something a bounded script should own):

```bash
npm run dev:backend    # http://localhost:4100
npm run dev:frontend   # http://localhost:3000 (or next free port)
```

## 3. Expected output

`db:migrate` (on a fresh database):

```
[migrate] running 001_init.sql
[migrate] done    001_init.sql
[migrate] running 002_history_events.sql
[migrate] done    002_history_events.sql
[migrate] running 003_wallet_score_snapshots.sql
[migrate] done    003_wallet_score_snapshots.sql
[migrate] running 004_smart_money_signals.sql
[migrate] done    004_smart_money_signals.sql
[migrate] complete — 4 migration(s) applied, 4 total
```

On an already-migrated database, each line reads `[migrate] skip` instead
— that's expected, not an error.

`ingest:trades:once`:

```
[ingest:trades] fetched=20 new=20 duplicates=0 totalInDb=20 durationMs=255 runId=1
```

`ingest:rankings` — expect interleaved `429` retry lines; these are
normal (see §5), not failures, as long as the final line says
`0 failed`:

```
[jupiter-client] 429 on /profiles/... (attempt 1/3) — remaining=0 reset=... — retrying in 5000ms
[ingest:profile] wallet=... durationMs=... runId=...
...
[ingest:rankings] done — leaderboards + 20 profile(s) succeeded, 0 failed
```

`ingest:positions:recent` / `ingest:history:recent`:

```
[ingest:positions:recent] 5 candidate wallet(s) (limit=5, sinceMinutes=60)
[ingest:positions] wallet=... fetched=... upserted=... totalInDb=... durationMs=... runId=...
...
[ingest:positions:recent] done — 5 succeeded, 0 failed, 5 considered
```

`analytics:scores`:

```
[analytics:scores] 254 candidate wallet(s) gathered (max=500)
[analytics:scores] snapshotAt=... scored=254 inserted=254 duplicates=0 durationMs=242
```

`analytics:signals:persist`:

```
[analytics:signals:persist] lookbackMinutes=1440 minSmartScore=1 consensusWallets=2 whaleUsd=15
[analytics:signals:persist] fetched=20 detected=30 inserted=30 duplicates=0 durationMs=25
```

If `detected=0`, see §5 (Troubleshooting) — an empty first run is the
single most common demo-prep surprise.

## 4. Picking a good demo wallet

The dashboard's **Top Smart Score Wallets** card (or
`GET /api/scores/latest`) already ranks every scored wallet — the
highest-scoring one with a nonzero trade count is usually your best
demo wallet, since it'll have a populated Smart Score breakdown, wallet
stats, and (if it was one of the up-to-5 wallets `ingest:positions:recent`/
`ingest:history:recent` picked) positions and history too.

To confirm a wallet has the richest possible page (score + positions +
history, not just trades), query directly:

```sql
SELECT s.wallet_pubkey, s.score, s.tier,
       (SELECT COUNT(*) FROM trades t WHERE t.owner_pubkey = s.wallet_pubkey) AS trades,
       (SELECT COUNT(*) FROM positions p WHERE p.owner_pubkey = s.wallet_pubkey) AS positions,
       (SELECT COUNT(*) FROM history_events h WHERE h.owner_pubkey = s.wallet_pubkey) AS history
FROM wallet_score_snapshots s
WHERE s.snapshot_at = (SELECT MAX(snapshot_at) FROM wallet_score_snapshots)
ORDER BY s.score DESC, trades DESC
LIMIT 10;
```

Pick the top row with `positions > 0 AND history > 0` — that wallet's
`/wallet/:walletPubkey` page will show every section populated, not just
Smart Score + trades. Demo scores from a single `demo:prepare` run will
be low (single digits, `weak` tier) — that's expected and correct, not a
bug (see §5); Smart Score requires real accumulated trading history a
few tens of trades can't yet provide, and `--minSmartScore=1` only
loosens *signal detection*, not the score formula itself.

## 5. Picking a good demo market

The dashboard's **Trending Markets** or **Top Active Markets** card
surfaces the busiest markets directly — the top row of either is a
reasonable demo market. For one with whale/consensus signals too
(the richest possible `/market/:marketId` page), cross-reference:

```sql
SELECT market_id, COUNT(*) AS trades, COUNT(DISTINCT owner_pubkey) AS wallets
FROM trades
GROUP BY market_id
ORDER BY trades DESC
LIMIT 10;
```

then check which of those already has signals:

```sql
SELECT market_id, type, COUNT(*)
FROM smart_money_signals
GROUP BY market_id, type
ORDER BY market_id;
```

A market appearing in both — several trades from multiple wallets, and
at least a `whale_trade` or `market_consensus` row — will render every
section of `/market/:marketId` (Trending Market, Yes/No breakdown, top
wallets, whale/consensus signals, recent trades) with real data instead
of empty states.

## 6. Troubleshooting

- **`detected=0` / `inserted=0` on `analytics:signals:persist`** — the
  demo dataset is small and every wallet is newly-scored (low Smart
  Score, short trade history). `demo:prepare` already loosens the
  thresholds for this reason; if you ran the underlying jobs by hand
  instead of via `npm run demo:prepare`, make sure you passed the same
  `--lookbackMinutes=1440 --minSmartScore=1 --whaleUsd=15
  --consensusWallets=2` flags (or something similarly loose) rather than
  the production defaults.
- **Dashboard's "Active Smart Wallets" card is empty even though "Top
  Smart Score Wallets" shows real wallets** — expected on fresh demo
  data. "Active Smart Wallets" requires a *real* Smart Score `>= 35`;
  the lowered `--minSmartScore=1` flag only affects which wallets count
  toward *signal* detection, not the Smart Score formula, so a
  freshly-ingested wallet with a genuinely low score (reflecting a tiny
  real trade sample) correctly doesn't qualify. This is not a bug —
  Smart Score is deliberately conservative (see `docs/smart-score.md`).
- **`429` lines during `ingest:rankings`/`ingest:positions:recent`/
  `ingest:history:recent`** — normal. This project runs keyless against
  Jupiter's public rate limit; the client retries automatically (see
  `[jupiter-client] 429 ... retrying in ...ms` lines) and the job's own
  final summary line (`... 0 failed`) is what actually indicates success.
- **`DATABASE_URL` error / `demo:prepare` fails immediately** — no
  `.env` present, or it's missing `DATABASE_URL`. See `README.md` §5.
- **Frontend shows an empty dashboard/wallet/market page after
  `demo:prepare` finished successfully** — the frontend and backend are
  two separate processes; make sure both `npm run dev:backend` and
  `npm run dev:frontend` are actually running (§2), and that
  `NEXT_PUBLIC_API_BASE_URL` (if you're not using the default port
  4100) matches wherever the backend actually started.
- **Re-running `demo:prepare` against the same database** — safe.
  Ingestion is `ON CONFLICT (id) DO NOTHING`-idempotent; Smart Score
  snapshots are bucketed and signals are content-derived-ID-idempotent
  (see `README.md`'s ingestion/idempotency notes) — re-running just adds
  a fresh trade poll and a fresh score/signal snapshot on top of what's
  already there, it doesn't duplicate or corrupt anything.
- **Port 3000 already in use** — Next.js auto-picks the next free port
  and prints it (e.g. `3004`); this is normal, not a demo-prep failure.
