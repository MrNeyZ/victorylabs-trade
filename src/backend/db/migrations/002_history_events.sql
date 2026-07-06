-- Wallet-scoped history ingestion — Phase 2.4.
--
-- Mirrors GET /history (v1, `ownerPubkey` required — see
-- docs/rest-api-capabilities.md §3.1). This is a deliberately narrower
-- column set than the full ~35-property HistoryEvent schema (the beta
-- API's 14-value `eventType` enum spans order/position/ticket lifecycles
-- with different meaningful fields per type); only the fields useful for
-- wallet-activity/reconciliation are promoted to columns, the full
-- upstream object is preserved in `raw` (here NOT NULL, unlike trades.raw,
-- since a history row is meaningless without its full context — action/
-- side/amount are themselves *derived*, not verbatim upstream fields; see
-- src/backend/core/normalizeHistoryEvent.ts).
--
-- Primary key: upstream `HistoryEvent.id` (a stable, unique, monotonically
-- increasing integer per event — confirmed live 2026-07-06), stored as
-- TEXT for consistency with trades.id and to leave room for a future
-- non-numeric id shape without a type change. No composite-key fallback
-- was needed since upstream does provide a stable id.
--
-- No FK constraints to markets/positions/wallets — same reasoning as
-- 001_init.sql: this loop polls independently per wallet and must not
-- become insert-order-dependent on other tables.
CREATE TABLE IF NOT EXISTS history_events (
  id                    TEXT PRIMARY KEY,
  owner_pubkey          TEXT NOT NULL,
  market_id             TEXT,
  position_pubkey       TEXT,
  -- Derived from upstream `isBuy`/`isYes` booleans (there is no upstream
  -- "action"/"side" string field on HistoryEvent, unlike Trade) — see
  -- normalizeHistoryEvent.ts. Meaningful for fill-type events; present but
  -- less semantically useful for settlement/payout events.
  action                TEXT CHECK (action IN ('buy', 'sell')),
  side                  TEXT CHECK (side IN ('yes', 'no')),
  event_title           TEXT,
  upstream_timestamp    TIMESTAMPTZ,
  amount_usd            NUMERIC,
  price                 NUMERIC,
  realized_pnl_usd      NUMERIC,
  transaction_signature TEXT,
  raw                   JSONB NOT NULL,
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  inserted_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_history_events_owner_pubkey ON history_events (owner_pubkey);
CREATE INDEX IF NOT EXISTS idx_history_events_market_id ON history_events (market_id);
CREATE INDEX IF NOT EXISTS idx_history_events_position_pubkey ON history_events (position_pubkey);
CREATE INDEX IF NOT EXISTS idx_history_events_upstream_timestamp ON history_events (upstream_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_history_events_transaction_signature
  ON history_events (transaction_signature) WHERE transaction_signature IS NOT NULL;
