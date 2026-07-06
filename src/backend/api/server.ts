/**
 * Read-only HTTP API over the ingested Postgres data.
 *
 * Run with: npm run backend:dev
 *
 * This process does NOT trigger ingestion — it only reads what the
 * ingestion jobs (`src/backend/jobs/ingest*.ts`) already wrote to
 * Postgres. It is not started via PM2 or any production process manager
 * in this phase: it's a normal foreground dev server, started and
 * stopped manually (Ctrl-C / SIGTERM), same as any other Express app in
 * development.
 *
 * Express 5 (not 4) was chosen deliberately: it forwards a rejected
 * promise from an async route handler to the error-handling middleware
 * automatically, so routes below don't need a manual try/catch or an
 * asyncHandler wrapper around every handler.
 *
 * `DATABASE_URL` is required — `getPool()` (see `../db/client.ts`) throws
 * if it's unset, and that's called here before the server starts
 * listening, not lazily on the first request.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { getPool, closePool } from '../db/client.js';
import { healthRouter } from './routes/health.js';
import { tradesRouter } from './routes/trades.js';
import { walletsRouter } from './routes/wallets.js';
import { leaderboardsRouter } from './routes/leaderboards.js';

const DEFAULT_PORT = 4100;

export function createServer(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use('/health', healthRouter);
  app.use('/api/trades', tradesRouter);
  app.use('/api/wallets', walletsRouter);
  app.use('/api/leaderboards', leaderboardsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    console.error(`[api] unhandled error on ${req.method} ${req.path}`, err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnvIfPresent();

  // Fail loudly on a missing DATABASE_URL before binding a port, not on
  // the first incoming request.
  getPool();

  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const app = createServer();

  const server = app.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port} (read-only, no ingestion triggered)`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] received ${signal} — shutting down`);
    server.close(() => {
      closePool()
        .catch((err: unknown) => console.error('[api] error closing pool', err))
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[api] fatal', err);
  process.exitCode = 1;
});
