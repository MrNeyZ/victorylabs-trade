-- VictoryLabs Smart Score persistence — Phase 3.3.
--
-- Genuine time series, same reasoning as `leaderboard_snapshots`
-- (001_init.sql): the whole point of persisting scores on a schedule is
-- watching a wallet's score/tier evolve, so this is one row per
-- (wallet, snapshot) rather than an upsert-latest table.
--
-- `snapshot_at` is floored to a 5-minute bucket by the caller
-- (`src/backend/jobs/computeWalletScores.ts`, mirroring
-- `ingestLeaderboards.ts`'s `floorToBucket`) — the `UNIQUE
-- (wallet_pubkey, snapshot_at)` constraint is what makes re-running the
-- job within the same bucket idempotent (`ON CONFLICT DO NOTHING`), not a
-- coincidence of the column types.
--
-- `explanation`/`stats` are JSONB, not typed columns: `explanation` is
-- `WalletScore.explanations` (a plain string array) and `stats` is the
-- full `WalletStats` object the score was computed from — both are our
-- own derived output, not an upstream payload, but still free-form enough
-- (and still evolving alongside `computeWalletScore.ts`/
-- `computeWalletStats.ts`) that locking them into typed columns here
-- would couple this migration to those modules' exact shape.
--
-- No FK to `wallets`/`wallet_profiles` — same reasoning as every other
-- table in this project (001_init.sql): this job scores whatever
-- candidate wallets `gatherCandidateWallets.ts` finds independently of
-- other tables' ingestion state.
CREATE TABLE IF NOT EXISTS wallet_score_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  wallet_pubkey   TEXT NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL,
  score           INTEGER NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('elite', 'strong', 'watch', 'weak', 'unknown')),
  profitability   INTEGER NOT NULL,
  consistency     INTEGER NOT NULL,
  activity        INTEGER NOT NULL,
  recency         INTEGER NOT NULL,
  sample_size     INTEGER NOT NULL,
  explanation     JSONB NOT NULL,
  stats           JSONB NOT NULL,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_pubkey, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_wallet_score_snapshots_snapshot_at
  ON wallet_score_snapshots (snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_score_snapshots_score
  ON wallet_score_snapshots (score DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_score_snapshots_tier
  ON wallet_score_snapshots (tier);
CREATE INDEX IF NOT EXISTS idx_wallet_score_snapshots_wallet_pubkey
  ON wallet_score_snapshots (wallet_pubkey);
