// Scheduled/background jobs.
// ingestTradesOnce.ts and pollTrades.ts here are CLI entry points
// (npm run ingest:trades:once / npm run ingest:trades:poll) that run
// immediately on import — intentionally NOT re-exported from this barrel,
// same reason src/backend/db/index.ts excludes migrate.ts.
export {};
