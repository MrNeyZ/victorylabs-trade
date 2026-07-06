// Scheduled/background jobs.
// `ingestTradesOnce.ts` here is a CLI entry point (npm run ingest:trades:once)
// that runs immediately on import — intentionally NOT re-exported from this
// barrel, same reason src/backend/db/index.ts excludes migrate.ts.
export {};
