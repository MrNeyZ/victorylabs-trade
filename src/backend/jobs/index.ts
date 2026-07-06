// Scheduled/background jobs.
// Every file in this directory (ingestTradesOnce.ts, pollTrades.ts,
// ingestRecentWalletHistory.ts, ingestRankings.ts,
// ingestRecentWalletPositions.ts, analyticsWallet.ts) is a CLI entry
// point that runs immediately on import — intentionally NOT re-exported
// from this barrel, same reason src/backend/db/index.ts excludes
// migrate.ts.
export {};
