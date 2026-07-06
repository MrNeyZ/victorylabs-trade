/**
 * GET /api/scores/latest — the most recent ingested Smart Score snapshot
 * bucket across all wallets, optionally filtered by `tier`/`minScore`.
 * Read-only against Postgres (never live-computed) — see
 * `src/backend/jobs/computeWalletScores.ts` for how the bucket is
 * produced.
 */
import { Router } from 'express';
import {
  getLatestWalletScores,
  type GetLatestWalletScoresOptions,
} from '../../db/repositories/walletScoresRepository.js';
import type { WalletScoreTier } from '../../analytics/scoring/computeWalletScore.js';
import { firstQueryString, parseLimitParam } from '../queryParams.js';

export const scoresRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_TIERS: WalletScoreTier[] = ['elite', 'strong', 'watch', 'weak', 'unknown'];

function isWalletScoreTier(value: string): value is WalletScoreTier {
  return (VALID_TIERS as string[]).includes(value);
}

type ParseMinScoreResult = { ok: true; value: number | undefined } | { ok: false; message: string };

function parseMinScoreParam(value: unknown): ParseMinScoreResult {
  if (value === undefined) return { ok: true, value: undefined };

  const raw = firstQueryString(value);
  if (raw === undefined) {
    return { ok: false, message: 'minScore must be a single value' };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: 'minScore must be a number' };
  }

  return { ok: true, value: parsed };
}

scoresRouter.get('/latest', async (req, res) => {
  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const tierParam = firstQueryString(req.query['tier']);
  if (tierParam !== undefined && !isWalletScoreTier(tierParam)) {
    res.status(400).json({
      error: 'invalid_tier',
      message: `tier must be one of: ${VALID_TIERS.join(', ')}`,
    });
    return;
  }

  const minScoreResult = parseMinScoreParam(req.query['minScore']);
  if (!minScoreResult.ok) {
    res.status(400).json({ error: 'invalid_min_score', message: minScoreResult.message });
    return;
  }

  const options: GetLatestWalletScoresOptions = { limit: limitResult.value };
  if (tierParam !== undefined) options.tier = tierParam;
  if (minScoreResult.value !== undefined) options.minScore = minScoreResult.value;

  const snapshot = await getLatestWalletScores(options);

  res.json(snapshot);
});
