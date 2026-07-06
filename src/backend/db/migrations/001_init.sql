-- Initial schema for VictoryLabs Trade — Phase 2.1.
--
-- Design notes (see docs/rest-api-capabilities.md and
-- docs/rest-api-validation.md for the research this is based on):
--
--   * Upstream IDs are used as primary keys wherever one exists
--     (trades.id, markets.market_id, positions.position_pubkey,
--     wallets/wallet_profiles.wallet_pubkey). leaderboard_snapshots and
--     ingestion_runs have no natural upstream ID (a leaderboard row is a
--     recurring (wallet, period) pair sampled over time; an ingestion run
--     is purely our own bookkeeping) so they use a surrogate BIGSERIAL.
--
--   * Money and contract-count fields are unconstrained NUMERIC, never
--     BIGINT/FLOAT. Upstream sends these as decimal strings specifically
--     to survive u64/u128/i128 magnitudes without precision loss (see
--     docs/jupiter-prediction-discovery.md §3) — BIGINT tops out at 2^63-1
--     and would risk silent overflow on the largest values Jupiter's own
--     schema documents (u128 cost-basis fields); unconstrained NUMERIC has
--     no such ceiling. Values are stored converted to actual USD (not
--     upstream's micro-USD units) — see src/backend/types/domain.ts.
--
--   * No foreign-key constraints between tables. `trades`/`positions`/
--     `leaderboard_snapshots` reference wallet/market identifiers as plain
--     TEXT, not FKs into `wallets`/`markets`. This is deliberate: those
--     ingestion loops will poll independently (see
--     docs/jupiter-prediction-discovery.md §9) and may see a trade for a
--     market or wallet before that market/wallet has been fetched on its
--     own slower loop. An FK would make ingestion order-dependent for no
--     real benefit here; the same tradeoff nft-live-feed already made
--     (`ON CONFLICT (signature) DO NOTHING`, no FK coupling).
--
--   * Every ingestion-facing table has a `raw JSONB` column holding the
--     full upstream object. The API is explicitly beta ("subject to
--     breaking changes" — docs/jupiter-prediction-discovery.md §2); this
--     is a safety net against losing data to fields we haven't normalized
--     yet, not a substitute for the typed columns.
--
--   * `wallet_profiles` holds the LATEST snapshot per wallet (upsert by
--     wallet_pubkey) — a current-state table. `leaderboard_snapshots` is
--     a genuine time series (one row per wallet/period/poll) — the
--     "_snapshots" naming distinction is intentional, not accidental.

-- ── wallets ──────────────────────────────────────────────────────────────────
-- Lightweight dimension table for any wallet pubkey observed anywhere
-- (trade, position, leaderboard entry, profile lookup). No FK is made FROM
-- this table TO anything else, and nothing else has an FK INTO it (see
-- note above) — it exists so "which wallets have we ever seen" is a single
-- cheap query instead of a UNION across every ingestion table.
CREATE TABLE IF NOT EXISTS wallets (
  wallet_pubkey       TEXT PRIMARY KEY,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_context   TEXT
);

-- ── markets ──────────────────────────────────────────────────────────────────
-- Mirrors GET /markets/{marketId} (the `Market` schema). `event_id` is
-- nullable because the bare Market schema does not include it — it's only
-- known when a market arrives nested as `marketMetadata` inside a trade,
-- position, or history row (see docs/rest-api-capabilities.md §2, §3).
CREATE TABLE IF NOT EXISTS markets (
  market_id           TEXT PRIMARY KEY,
  event_id            TEXT,
  provider            TEXT,
  title               TEXT,
  subtitle            TEXT,
  status              TEXT CHECK (status IN ('open', 'closed')),
  result              TEXT CHECK (result IN ('yes', 'no', 'draw')),
  market_result_pubkey TEXT,
  is_team_market      BOOLEAN,
  sports_market_type  TEXT,
  open_time           TIMESTAMPTZ,
  close_time          TIMESTAMPTZ,
  -- Upstream sends this as an ISO 8601 string, unlike open_time/close_time
  -- (unix seconds) — a confirmed inconsistency, not a mistake here.
  resolve_at          TIMESTAMPTZ,
  buy_yes_price_usd   NUMERIC,
  buy_no_price_usd    NUMERIC,
  sell_yes_price_usd  NUMERIC,
  sell_no_price_usd   NUMERIC,
  volume_usd          NUMERIC,
  rules_primary       TEXT,
  rules_secondary     TEXT,
  image_url           TEXT,
  raw                 JSONB,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_markets_event_id ON markets (event_id);

-- ── trades ───────────────────────────────────────────────────────────────────
-- Mirrors GET /trades (global feed — no pagination upstream, ~20-row/~7min
-- window; see docs/rest-api-capabilities.md §3.5 and the 24.4h validation
-- in docs/rest-api-validation.md). `id` is the upstream trade id
-- (e.g. "order-2357571").
CREATE TABLE IF NOT EXISTS trades (
  id                  TEXT PRIMARY KEY,
  owner_pubkey        TEXT NOT NULL,
  market_id           TEXT NOT NULL,
  event_id            TEXT,
  action              TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
  side                TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  amount_usd          NUMERIC NOT NULL,
  price_usd           NUMERIC NOT NULL,
  event_title         TEXT,
  market_title        TEXT,
  message             TEXT,
  is_team_market      BOOLEAN,
  upstream_timestamp  TIMESTAMPTZ NOT NULL,
  raw                 JSONB,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_owner_pubkey ON trades (owner_pubkey);
CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades (market_id);
CREATE INDEX IF NOT EXISTS idx_trades_upstream_timestamp ON trades (upstream_timestamp DESC);

-- ── wallet_profiles ──────────────────────────────────────────────────────────
-- Latest snapshot per wallet from GET /profiles/{ownerPubkey}. Upsert by
-- wallet_pubkey — this table does NOT keep history (see leaderboard_snapshots
-- for the time-series equivalent).
CREATE TABLE IF NOT EXISTS wallet_profiles (
  wallet_pubkey               TEXT PRIMARY KEY,
  realized_pnl_usd             NUMERIC NOT NULL,
  total_volume_usd              NUMERIC NOT NULL,
  predictions_count            INTEGER NOT NULL,
  correct_predictions          INTEGER NOT NULL,
  wrong_predictions            INTEGER NOT NULL,
  total_active_contracts       NUMERIC,
  total_active_contracts_micro NUMERIC,
  total_positions_value_usd    NUMERIC,
  raw                          JSONB,
  snapshot_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── positions ────────────────────────────────────────────────────────────────
-- Latest known state per position, from GET /positions (v1 array, or v2
-- grouped-by-owner — both share the same `Position` schema, see
-- docs/rest-api-capabilities.md §3.3). `position_pubkey` is upstream's
-- `pubkey` field. Only the fields most relevant to smart-money analysis are
-- promoted to columns; the full ~40-property object is preserved in `raw`.
CREATE TABLE IF NOT EXISTS positions (
  position_pubkey     TEXT PRIMARY KEY,
  owner_pubkey        TEXT NOT NULL,
  market_id           TEXT NOT NULL,
  event_id            TEXT,
  is_yes              BOOLEAN,
  side_label          TEXT CHECK (side_label IN ('Up', 'Down')),
  contracts_micro     NUMERIC,
  -- "0" when basis is unknown upstream (Forecast self-custody ledger gap —
  -- see docs/rest-api-capabilities.md §3.3). Stored as-is, not corrected.
  total_cost_usd      NUMERIC,
  value_usd           NUMERIC,
  avg_price_usd       NUMERIC,
  mark_price_usd      NUMERIC,
  pnl_usd             NUMERIC,
  pnl_usd_after_fees  NUMERIC,
  realized_pnl_usd    NUMERIC,
  fees_paid_usd       NUMERIC,
  claimed             BOOLEAN,
  claimed_usd         NUMERIC,
  claimable           BOOLEAN,
  payout_usd          NUMERIC,
  lifecycle_status    TEXT CHECK (lifecycle_status IN ('open', 'resolving', 'settled')),
  opened_at           TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ,
  claimable_at        TIMESTAMPTZ,
  settlement_date     TIMESTAMPTZ,
  raw                 JSONB,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_positions_owner_pubkey ON positions (owner_pubkey);
CREATE INDEX IF NOT EXISTS idx_positions_market_id ON positions (market_id);

-- ── leaderboard_snapshots ────────────────────────────────────────────────────
-- Genuine time series from GET /leaderboards — one row per
-- (wallet, period, snapshot) rather than an upsert-latest table, since the
-- whole point of tracking this over time is seeing how ranking/PnL evolves.
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id                   BIGSERIAL PRIMARY KEY,
  wallet_pubkey        TEXT NOT NULL,
  period               TEXT NOT NULL CHECK (period IN ('all_time', 'weekly', 'monthly')),
  -- Position in the returned array at fetch time — a direct mirror of
  -- upstream ordering, not a derived ranking score.
  rank                 INTEGER,
  realized_pnl_usd     NUMERIC NOT NULL,
  total_volume_usd     NUMERIC NOT NULL,
  predictions_count    INTEGER NOT NULL,
  correct_predictions  INTEGER NOT NULL,
  wrong_predictions    INTEGER NOT NULL,
  win_rate_pct         NUMERIC NOT NULL,
  period_start         TIMESTAMPTZ,
  period_end           TIMESTAMPTZ,
  raw                  JSONB,
  snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_pubkey, period, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_period_snapshot_at
  ON leaderboard_snapshots (period, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_wallet_pubkey
  ON leaderboard_snapshots (wallet_pubkey);

-- ── ingestion_runs ───────────────────────────────────────────────────────────
-- Operational bookkeeping for whatever polling loops a future phase builds
-- (one row per run, per endpoint) — no upstream equivalent, purely ours.
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id             BIGSERIAL PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  rows_fetched   INTEGER,
  rows_upserted  INTEGER,
  error_message  TEXT,
  metadata       JSONB
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_endpoint_started_at
  ON ingestion_runs (endpoint, started_at DESC);
