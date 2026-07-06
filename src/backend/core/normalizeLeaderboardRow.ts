/**
 * Converts a raw `/leaderboards` row into the normalized domain
 * `LeaderboardSnapshot` shape. Pure function, no I/O — the caller keeps
 * the raw payload separately for the `raw` JSONB column (see
 * `src/backend/db/repositories/leaderboardsRepository.ts`) and supplies
 * `rank` (this project's own array-position convention — see
 * `types/domain.ts`) and a shared `snapshotAt` for the whole batch (see
 * `src/backend/ingestion/ingestLeaderboards.ts`'s bucketing).
 *
 * `winRatePct` is NOT micro-USD-encoded (confirmed live: e.g. `"26.67"`,
 * `"100.00"`) — it's already a plain decimal percentage string. Running it
 * through `microUsdToUsd` would be wrong (and would throw, since it isn't
 * a bare integer string) — passed through as-is.
 */
import type { JupiterLeaderboardEntry } from '../types/jupiter.js';
import type { LeaderboardSnapshot } from '../types/domain.js';
import { microUsdToUsd } from '../utils/decimal.js';

export function normalizeLeaderboardRow(
  raw: JupiterLeaderboardEntry,
  rank: number,
  snapshotAt: Date,
): LeaderboardSnapshot {
  return {
    walletPubkey: raw.ownerPubkey,
    period: raw.period,
    rank,
    realizedPnlUsd: microUsdToUsd(raw.realizedPnlUsd),
    totalVolumeUsd: microUsdToUsd(raw.totalVolumeUsd),
    predictionsCount: raw.predictionsCount,
    correctPredictions: raw.correctPredictions,
    wrongPredictions: raw.wrongPredictions,
    winRatePct: raw.winRatePct,
    periodStart: raw.periodStart ? new Date(raw.periodStart) : null,
    periodEnd: raw.periodEnd ? new Date(raw.periodEnd) : null,
    snapshotAt,
  };
}
