// PM2 ecosystem — production process manifest for VictoryLabs Trade,
// Phase 4.5. Same pattern as the other VictoryLabs services on this VPS
// (see /root/nft-live-feed/ecosystem.config.cjs): one file per project,
// each managing only its own two apps — `pm2 start ecosystem.config.cjs`
// from this directory never touches nft-live-feed's or wallet-checker's
// separately-managed processes.
//
// Three apps, one host:
//   - vltrade-backend       (Express + read-only API + one SSE stream, 127.0.0.1:4100)
//   - vltrade-frontend      (Next.js production server, 127.0.0.1:4200)
//   - vltrade-trades-poller (Phase 6.1 — continuous `/trades` ingestion daemon,
//     no listening port at all; writes to Postgres only, same DB the
//     backend reads from)
//
// The backend/frontend are fronted by nginx on :443 (see
// /etc/nginx/sites-available/vltrade). Ports 4100/4200 are not reachable
// from outside this host at all — ufw's default-deny policy only opens
// 80/443 (Cloudflare ranges) and 22. The poller has no port and no nginx
// entry — it never serves anything, it only writes.
//
// The backend intentionally runs via `tsx` (interpreted TS), not a
// compiled `dist/` bundle — every phase of this project, dev and every
// prior verification pass alike, has only ever run it this way; this
// deployment phase is explicitly scoped to "deploy the existing MVP
// safely", not to stand up a new compiled-JS execution path that has
// never been exercised anywhere else in this project's history.
//
// Secrets come from `.env` (backend, loaded via `loadEnvIfPresent()` off
// `process.cwd()` — hence `cwd: HOME` below) and
// `src/frontend/.env.production` (frontend — inlined into the client
// bundle at `next build` time, not read at runtime). Neither is
// referenced here. `NODE_ENV=production` is set explicitly for both.
//
// `max_memory_restart` is a tripwire, not a tuning knob, sized down from
// nft-live-feed's (this app does far less in-memory work: no
// getProgramAccounts scans, no NFT metadata caches). `kill_timeout: 10000`
// gives the backend's own SIGINT/SIGTERM handler (`server.ts`) time to
// close the pool gracefully before PM2 SIGKILLs it.

const HOME = '/root/vl-trade';

module.exports = {
  apps: [
    {
      name: 'vltrade-backend',
      cwd: HOME,
      script: 'node_modules/.bin/tsx',
      args: 'src/backend/api/server.ts',
      env: { NODE_ENV: 'production' },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      kill_timeout: 10000,
      out_file: `${HOME}/logs/backend.out.log`,
      error_file: `${HOME}/logs/backend.err.log`,
      merge_logs: true,
      time: true,
    },
    {
      name: 'vltrade-frontend',
      cwd: HOME,
      script: 'node_modules/.bin/next',
      args: 'start src/frontend -p 4200',
      env: { NODE_ENV: 'production' },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M',
      out_file: `${HOME}/logs/frontend.out.log`,
      error_file: `${HOME}/logs/frontend.err.log`,
      merge_logs: true,
      time: true,
    },
    {
      // Phase 6.1 — replaces the one-time `ingest:trades:once` bootstrap
      // (README §13.5) as the thing that keeps `trades` fresh. Same CLI
      // entry point `npm run ingest:trades:poll` uses
      // (`src/backend/jobs/pollTrades.ts`), just with `--forever` instead
      // of the bounded default — one source of truth for the ingestion
      // logic either way (`src/backend/ingestion/pollTrades.ts`).
      //
      // `--interval=15` matches this project's own 24.4h-validated safe
      // cadence (`docs/rest-api-validation.md`) — written explicitly here
      // rather than relying on the script's own default, so the deployed
      // interval is visible in this file without cross-referencing the
      // ingestion module.
      //
      // No `max_memory_restart`: this process holds no meaningful
      // in-memory state between polls (no cache, no connection pool
      // beyond `pg`'s own), so there's no leak-tripwire scenario the way
      // there is for the backend/frontend above; PM2's default
      // `autorestart: true` is what actually matters here — a crash
      // (which the poller loop itself now tries hard to avoid per-poll,
      // see the ingestion module's own doc comment) still gets restarted
      // rather than silently staying down.
      name: 'vltrade-trades-poller',
      cwd: HOME,
      script: 'node_modules/.bin/tsx',
      args: 'src/backend/jobs/pollTrades.ts --forever --interval=15',
      env: { NODE_ENV: 'production' },
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 10000,
      out_file: `${HOME}/logs/trades-poller.out.log`,
      error_file: `${HOME}/logs/trades-poller.err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
