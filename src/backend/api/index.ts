// HTTP/API layer (routes, controllers).
// `server.ts` is a CLI entry point (npm run backend:dev) that starts
// listening immediately on import — intentionally NOT re-exported from
// this barrel, same reason src/backend/db/index.ts excludes migrate.ts.
// `createServer()` is exported from server.ts itself for anyone who wants
// just the Express app factory.
export {};
