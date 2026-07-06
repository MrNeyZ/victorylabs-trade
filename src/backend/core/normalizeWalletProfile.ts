/**
 * Converts a raw `/profiles/{ownerPubkey}` row into the normalized domain
 * `WalletProfile` shape. Pure function, no I/O — the caller keeps the raw
 * payload separately for the `raw` JSONB column (see
 * `src/backend/db/repositories/walletProfilesRepository.ts`).
 *
 * Field-unit notes (confirmed against a live re-probe, not just the
 * OpenAPI spec — consistent with the discipline established in
 * Phase 2.4's history normalization):
 *   - `realizedPnlUsd`/`totalPositionsValueUsd` are micro-USD strings —
 *     converted to actual USD.
 *   - `totalActiveContracts` (legacy floored whole-contract string) and
 *     `totalActiveContractsMicro` (micro-contract units) are NOT USD
 *     fields — stored as-is (the domain field's own "Micro" suffix
 *     signals it deliberately stays unconverted, matching
 *     `types/domain.ts`'s existing naming).
 *   - `predictionsCount`/`correctPredictions`/`wrongPredictions` are
 *     strings on this endpoint specifically (unlike `/leaderboards`,
 *     where the same-named fields are numbers — see `types/jupiter.ts`).
 */
import type { JupiterProfile } from '../types/jupiter.js';
import type { WalletProfile } from '../types/domain.js';
import { microUsdToUsd } from '../utils/decimal.js';
import { nullIfEmpty } from '../utils/strings.js';

export function normalizeWalletProfile(raw: JupiterProfile, snapshotAt: Date): WalletProfile {
  return {
    walletPubkey: raw.ownerPubkey,
    realizedPnlUsd: microUsdToUsd(raw.realizedPnlUsd),
    totalVolumeUsd: microUsdToUsd(raw.totalVolumeUsd),
    predictionsCount: Number(raw.predictionsCount),
    correctPredictions: Number(raw.correctPredictions),
    wrongPredictions: Number(raw.wrongPredictions),
    totalActiveContracts: nullIfEmpty(raw.totalActiveContracts),
    totalActiveContractsMicro: nullIfEmpty(raw.totalActiveContractsMicro),
    totalPositionsValueUsd: raw.totalPositionsValueUsd
      ? microUsdToUsd(raw.totalPositionsValueUsd)
      : null,
    snapshotAt,
  };
}
