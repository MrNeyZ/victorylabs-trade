-- Smart Money Signals persistence — Phase 3.6.
--
-- Unlike `wallet_score_snapshots` (BIGSERIAL surrogate key — a score has
-- no natural upstream id), signals already have a stable, deterministic
-- id computed by the pure detector itself
-- (`src/backend/analytics/signals/detectSmartMoneySignals.ts`'s
-- `signalId()` — type + market + side + a per-type stable key, no
-- random/clock component). That id IS the primary key here, TEXT, not a
-- surrogate — `ON CONFLICT (id) DO NOTHING` is what makes persisting the
-- same detected signal twice (e.g. two `analytics:signals:persist` runs
-- with overlapping lookback windows) a no-op instead of a duplicate row.
--
-- `market_id`/`side` are nullable (not NOT NULL) even though every
-- signal type detected so far always has both (every signal currently
-- originates from a trade, which always has a market+side) — this is
-- deliberately future-proofed for a signal type that isn't
-- market-scoped, rather than every future migration needing to loosen
-- a constraint that was too strict from the start.
--
-- `score_context`/`raw` are JSONB, not typed columns, same reasoning as
-- `wallet_score_snapshots.explanation`/`.stats` (003_wallet_score_snapshots.sql):
-- both are this project's own derived output, still evolving alongside
-- `detectSmartMoneySignals.ts`, and `raw` in particular is the full
-- `Signal` object verbatim — a safety net against any field not (yet)
-- promoted to its own column, same role `raw` plays on every
-- ingestion-facing table since 001_init.sql.
--
-- No FK to `trades`/`wallet_score_snapshots` — same reasoning as every
-- other table in this project: signal detection reads those tables at
-- computation time but a persisted signal must remain valid even if the
-- underlying trade/score rows it was derived from are never touched
-- again.
CREATE TABLE IF NOT EXISTS smart_money_signals (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (
                    type IN ('smart_wallet_trade', 'elite_wallet_trade', 'market_consensus', 'whale_trade')
                  ),
  severity        TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  wallet_pubkeys  TEXT[] NOT NULL,
  market_id       TEXT,
  side            TEXT CHECK (side IS NULL OR side IN ('yes', 'no')),
  event_title     TEXT,
  amount_usd      NUMERIC,
  score_context   JSONB NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  explanation     TEXT NOT NULL,
  raw             JSONB NOT NULL,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smart_money_signals_occurred_at
  ON smart_money_signals (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_smart_money_signals_type
  ON smart_money_signals (type);
CREATE INDEX IF NOT EXISTS idx_smart_money_signals_severity
  ON smart_money_signals (severity);
CREATE INDEX IF NOT EXISTS idx_smart_money_signals_market_id
  ON smart_money_signals (market_id);
-- GIN, not btree: `wallet_pubkeys` is an array column queried for
-- containment ("signals involving wallet X" — `WHERE wallet_pubkeys @>
-- ARRAY[$1]`), which only a GIN index over the array's elements can
-- support efficiently; a btree index on the array as a whole would only
-- help exact-whole-array-equality lookups, which this project has no use
-- for.
CREATE INDEX IF NOT EXISTS idx_smart_money_signals_wallet_pubkeys
  ON smart_money_signals USING GIN (wallet_pubkeys);
