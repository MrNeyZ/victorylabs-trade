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
  database is not reachable. Treat this as a DB incident (§6), not a
  backend incident.

```bash
curl -s https://trade.victorylabs.app/health
```

## 2. PM2 checks

```bash
pm2 list                          # status/uptime/restart-count for every process on the VPS
pm2 describe vltrade-backend       # full detail: script path, restarts, memory, cwd
pm2 describe vltrade-frontend
```

What to look at in `pm2 list`:

| Column | Healthy | Unhealthy |
|---|---|---|
| `status` | `online` | `stopped`, `errored` |
| `↺` (restarts) | low, stable over time | climbing steadily — a crash loop |
| `mem` | roughly stable | growing without bound (leak) — see `max_memory_restart` in `ecosystem.config.cjs`, which auto-restarts past 500M (backend) / 600M (frontend) |

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
(§5/§6), not nginx — nginx is shared infrastructure, and its own health
is easy to rule out first since a total nginx outage takes every
VictoryLabs subdomain down at once, not just this one.

## 4. Log commands

```bash
pm2 logs vltrade-backend            # live tail, both stdout+stderr
pm2 logs vltrade-frontend
pm2 logs vltrade-backend --lines 200 --nostream   # last 200 lines, no follow

# Same content, read directly off disk:
tail -f /root/vl-trade/logs/backend.out.log
tail -f /root/vl-trade/logs/backend.err.log
tail -f /root/vl-trade/logs/frontend.out.log
tail -f /root/vl-trade/logs/frontend.err.log

# nginx's own access/error logs (shared across all sites on this VPS —
# grep for the hostname to isolate vltrade's traffic):
tail -f /var/log/nginx/access.log | grep trade.victorylabs.app
tail -f /var/log/nginx/error.log
```

Logs rotate automatically via the VPS-wide `pm2-logrotate` module
(already installed for the other projects too) — nothing project-specific
to configure or clean up manually.

## 5. What "healthy" means

All of the following true at once:

1. `GET https://trade.victorylabs.app/health` → `200`, `ok: true`, `db: "ok"`.
2. `pm2 list` shows both `vltrade-backend` and `vltrade-frontend` as
   `online`, with no ongoing restart loop.
3. `https://trade.victorylabs.app/` and `/dashboard` load in a browser
   with no console errors and real data (not permanently stuck on a
   loading/error state).
4. The live feed (`/`) reaches `LIVE` status, not stuck on `Connecting`
   or `Disconnected` — confirms the SSE proxy path (nginx →
   `vltrade-backend` → browser) is intact end-to-end, which the plain
   `/health` check alone does not exercise.

A "degraded but not down" state is possible and not necessarily an
incident: e.g. `analytics:signals:persist` hasn't been re-run in a
while, so the dashboard's signal cards are stale or empty — see
`docs/mvp-status.md` and `README.md` §13.3 ("no persistent ingestion
scheduler yet" is a known, accepted gap, not a bug).

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
(not a `db: "error"` JSON body — that's a DB problem, §8), or `pm2 list`
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

## 8. If the database is down

Symptoms: `/health` responds (backend process is alive) but with
`"db": "error"` and a populated `dbError`; or `vltrade-backend` is
crash-looping with connection-refused errors in its logs.

```bash
systemctl status postgresql --no-pager
sudo -u postgres psql -c "SELECT 1;"          # confirm Postgres itself is up
sudo -u postgres psql -c "\l" | grep vltrade  # confirm the vltrade database still exists
pm2 restart vltrade-backend                   # once Postgres is confirmed healthy again
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

## 9. Suggested external monitor

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
