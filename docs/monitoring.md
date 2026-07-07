# Production Monitoring

Phase 4.5, post-deployment step 3. Basic operational monitoring guidance
for VictoryLabs Trade in production (`trade.victorylabs.app`). This is
guidance/runbook only — no new code, no monitoring agent, no alerting
integration was added; it documents what to check and how to check it.

See `README.md` §13 for the full deployment reference (PM2 process
names, nginx site, update/rollback procedures) this document builds on.

## 1. Health endpoint

```
GET https://trade.victorylabs.app/health
```

**Note:** the endpoint is `/health`, not `/api/health` — it is mounted
directly at the app root (`src/backend/api/server.ts`:
`app.use('/health', healthRouter)`), not under the `/api/` prefix the
rest of the backend's routes use. `/api/health` returns `404`.

Healthy response:

```json
{ "ok": true, "uptimeSeconds": 1673.9, "db": "ok", "dbError": null }
```

- `ok: true` — the Express process is up and able to respond.
- `db: "ok"` — a real `SELECT 1` against Postgres succeeded (not just "the
  process is alive"; this catches a backend that's running but can no
  longer reach the database).
- `db: "error"` with `dbError` populated — the process is up but the
  database is not reachable. Treat this as a DB incident (§9), not a
  backend incident.

```bash
curl -s https://trade.victorylabs.app/health
```

## 2. PM2 checks

```bash
pm2 list                          # status/uptime/restart-count for every process on the VPS
pm2 describe vltrade-backend       # full detail: script path, restarts, memory, cwd
pm2 describe vltrade-frontend
pm2 describe vltrade-trades-poller # Phase 6.1 — continuous /trades ingestion daemon
```

What to look at in `pm2 list`:

| Column | Healthy | Unhealthy |
|---|---|---|
| `status` | `online` | `stopped`, `errored` |
| `↺` (restarts) | low, stable over time | climbing steadily — a crash loop |
| `mem` | roughly stable | growing without bound (leak) — see `max_memory_restart` in `ecosystem.config.cjs`, which auto-restarts past 500M (backend) / 600M (frontend); the poller has no `max_memory_restart` — it holds no meaningful in-memory state, so there's nothing to leak the way there is for the other two |

`vltrade-trades-poller`'s restart count specifically should stay near
zero — its own per-iteration try/catch (§8 below) is designed so a single
bad poll never crashes the process, so a *process*-level restart there
means something PM2 itself intervened on (out-of-memory, an
unhandled exception past the loop's own safety net), worth investigating
same as a backend/frontend restart loop would be.

A single restart right after a deploy is expected (§13.3 of the README).
Restarts accumulating over hours/days with no deploy in between is the
signal worth investigating — check logs (§4) for the actual error first.

## 3. nginx checks

```bash
systemctl status nginx --no-pager   # is nginx itself running
nginx -t                            # validate config syntax (always run before reload)
curl -sk -o /dev/null -w "%{http_code}\n" https://trade.victorylabs.app/   # 200 expected
```

If nginx is up but `trade.victorylabs.app` doesn't respond correctly
while `nft-live-feed`/`wallet-checker` (the other sites on this VPS) do,
the fault is almost certainly in `vltrade-backend`/`vltrade-frontend`
(§6/§7), not nginx — nginx is shared infrastructure, and its own health
is easy to rule out first since a total nginx outage takes every
VictoryLabs subdomain down at once, not just this one.

## 4. Log commands

```bash
pm2 logs vltrade-backend            # live tail, both stdout+stderr
pm2 logs vltrade-frontend
pm2 logs vltrade-trades-poller      # live tail — one [trade-poller] line per ~15s iteration
pm2 logs vltrade-backend --lines 200 --nostream   # last 200 lines, no follow

# Same content, read directly off disk:
tail -f /root/vl-trade/logs/backend.out.log
tail -f /root/vl-trade/logs/backend.err.log
tail -f /root/vl-trade/logs/frontend.out.log
tail -f /root/vl-trade/logs/frontend.err.log
tail -f /root/vl-trade/logs/trades-poller.out.log
tail -f /root/vl-trade/logs/trades-poller.err.log

# nginx's own access/error logs (shared across all sites on this VPS —
# grep for the hostname to isolate vltrade's traffic):
tail -f /var/log/nginx/access.log | grep trade.victorylabs.app
tail -f /var/log/nginx/error.log
```

A healthy `vltrade-trades-poller` line looks like:

```
[trade-poller] fetched=20 new=1 duplicates=19 duration=229ms latestObservedAt=2026-07-07T14:43:37.800Z
```

`fetched`/`duplicates` staying high while `new` stays low is normal and
expected (`/trades` is a small, mostly-overlapping rolling window between
15s polls — see `docs/rest-api-capabilities.md` §3.5) — it does **not**
mean ingestion is stuck. `latestObservedAt` advancing every iteration is
the actual liveness signal (§8 below).

Logs rotate automatically via the VPS-wide `pm2-logrotate` module
(already installed for the other projects too) — nothing project-specific
to configure or clean up manually.

## 5. What "healthy" means

All of the following true at once:

1. `GET https://trade.victorylabs.app/health` → `200`, `ok: true`, `db: "ok"`.
2. `pm2 list` shows `vltrade-backend`, `vltrade-frontend`, and
   `vltrade-trades-poller` all as `online`, with no ongoing restart loop.
3. `https://trade.victorylabs.app/` and `/dashboard` load in a browser
   with no console errors and real data (not permanently stuck on a
   loading/error state).
4. The live feed (`/`) reaches `LIVE` status, not stuck on `Connecting`
   or `Disconnected` — confirms the SSE proxy path (nginx →
   `vltrade-backend` → browser) is intact end-to-end, which the plain
   `/health` check alone does not exercise.
5. `GET /api/trades/recent?limit=1`'s single row's `observedAt` is recent
   (within the last ~30s) — confirms `vltrade-trades-poller` (§8) is not
   just `online` in PM2 but actually still writing new rows, which
   `pm2 list`'s `status` column alone cannot tell you (a process can be
   `online` and stuck in a silent failure loop).

A "degraded but not down" state is possible and not necessarily an
incident: e.g. `analytics:signals:persist` hasn't been re-run in a
while, so the dashboard's signal cards are stale or empty — see
`docs/mvp-status.md` and `README.md` §13.3. **This no longer applies to
`trades` itself** (Phase 6.1 made that continuous — see §8 below); it
still applies to `/history`/`/positions`/`/profiles`/leaderboard/
Smart-Score data, which remain bounded, manually-run jobs.

## 6. If the frontend is down

Symptoms: `/health` still returns `ok: true` (backend is fine), but
`https://trade.victorylabs.app/` doesn't load, or `pm2 list` shows
`vltrade-frontend` as `stopped`/`errored`/crash-looping.

```bash
pm2 describe vltrade-frontend        # check restart count, uptime
pm2 logs vltrade-frontend --lines 100 --nostream   # look for the actual error
pm2 restart vltrade-frontend
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4200/    # confirm it's serving locally first
```

If it won't stay up after a restart, the most common cause is a missing
or stale production build — confirm `src/frontend/.next/` exists and was
built after the last `git pull`:

```bash
cd /root/vl-trade
npm run frontend:build
pm2 restart vltrade-frontend
```

## 7. If the backend is down

Symptoms: `/health` times out or returns a connection error entirely
(not a `db: "error"` JSON body — that's a DB problem, §9), or `pm2 list`
shows `vltrade-backend` as `stopped`/`errored`.

```bash
pm2 describe vltrade-backend
pm2 logs vltrade-backend --lines 100 --nostream
pm2 restart vltrade-backend
curl -s http://127.0.0.1:4100/health    # confirm it's serving locally first
```

Since the frontend calls the backend through nginx on the same origin
(`NEXT_PUBLIC_API_BASE_URL` is empty in production — see README §13.1),
a backend outage takes down every page's data (dashboard, wallet, market,
live feed) even though the frontend process itself is still `online` —
don't mistake "frontend pages render an empty shell" for a frontend
problem when the backend is the actual cause.

## 8. If the trades poller is stuck or down (Phase 6.1)

Two distinct failure modes, not one — check which:

**A. Process itself is down** (`pm2 list` shows `vltrade-trades-poller`
as `stopped`/`errored`, or missing entirely):

```bash
pm2 describe vltrade-trades-poller
pm2 logs vltrade-trades-poller --lines 100 --nostream
pm2 restart vltrade-trades-poller
```

This should be rare — the poller's own loop (§4 above,
`src/backend/ingestion/pollTrades.ts`) already catches a single failed
iteration and logs `[trade-poller] iteration failed, continuing: ...`
without crashing the process, specifically so a transient upstream
error/rate-limit/DB hiccup doesn't take down continuous ingestion.
A process-level restart count climbing here means something got past
that safety net (e.g. an out-of-memory kill) — check
`vltrade-trades-poller`'s `err.log` for what actually happened, same as
any other crash-looping process.

**B. Process is `online`, but ingestion is silently stuck** — the more
important case, since `pm2 list`'s `status` column will not show this:

```bash
curl -s "https://trade.victorylabs.app/api/trades/recent?limit=1" | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['observedAt'])"
# Compare against the current time — should be within ~15-30s.

pm2 logs vltrade-trades-poller --lines 20 --nostream
# Repeated "[trade-poller] iteration failed, continuing: ..." lines
# (not the normal fetched=/new=/duplicates= line) means every poll is
# hitting the same persistent error (e.g. Jupiter API outage, a changed
# response shape, or DATABASE_URL no longer valid) — the loop is alive
# and retrying every 15s, but not actually writing anything.
```

If it's genuinely stuck on a persistent upstream error, restarting the
process won't fix it (the error will just recur next iteration) — read
the actual error message in the logs first. If Postgres itself is the
problem, see §9 below; a Postgres outage will make every iteration fail
the same way this process's own DB writes do, not just the poller.

## 9. If the database is down

Symptoms: `/health` responds (backend process is alive) but with
`"db": "error"` and a populated `dbError`; or `vltrade-backend` is
crash-looping with connection-refused errors in its logs.

```bash
systemctl status postgresql --no-pager
sudo -u postgres psql -c "SELECT 1;"          # confirm Postgres itself is up
sudo -u postgres psql -c "\l" | grep vltrade  # confirm the vltrade database still exists
pm2 restart vltrade-backend vltrade-trades-poller   # once Postgres is confirmed healthy again
```

A Postgres restart/crash affects every project on this VPS that uses it
(this database instance is shared — `nft_live_feed` is a separate
database on the same Postgres server, per `docs/demo-workflow.md`'s
sibling-service notes) — if Postgres itself needed restarting, sanity
check `nft-backend`/`wallet-checker-backend` too, not just vltrade's.

If the database is confirmed up and reachable but empty/corrupted,
restore from the most recent backup — see the backup files and
`SHA256SUMS` under `/root/vl-trade-backups/` (post-deployment step 2);
this is a manual, deliberate operation, not something to script blindly
against a live production database.

## 10. Suggested external monitor

Point an external uptime monitor (e.g. UptimeRobot, Better Uptime, a
cron job elsewhere hitting this URL) at:

```
GET https://trade.victorylabs.app/health
Interval: every 1 minute
Expect: HTTP 200, body contains "ok":true
```

An external monitor matters specifically because it checks the full
path a real visitor takes — Cloudflare → nginx → `vltrade-backend` — not
just "is the process alive on the VPS," which a local `pm2 list` alone
cannot confirm (nginx or Cloudflare could be misconfigured while PM2
still shows everything `online`).
