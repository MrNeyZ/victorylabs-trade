// PM2 ecosystem — production process manifest for VictoryLabs Trade,
// Phase 4.5. Same pattern as the other VictoryLabs services on this VPS
// (see /root/nft-live-feed/ecosystem.config.cjs): one file per project,
// each managing only its own two apps — `pm2 start ecosystem.config.cjs`
// from this directory never touches nft-live-feed's or wallet-checker's
// separately-managed processes.
//
// Two apps, one host:
//   - vltrade-backend   (Express + read-only API + one SSE stream, 127.0.0.1:4100)
//   - vltrade-frontend  (Next.js production server, 127.0.0.1:4200)
//
// Both are fronted by nginx on :443 (see /etc/nginx/sites-available/vltrade).
// Ports 4100/4200 are not reachable from outside this host at all — ufw's
// default-deny policy only opens 80/443 (Cloudflare ranges) and 22.
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
  ],
};
