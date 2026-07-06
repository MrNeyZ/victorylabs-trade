/**
 * GET /api/signals/recent — Smart Money Signals detected over a recent
 * trade window (Phase 3.5). Unlike `/api/scores/latest`, this is NOT a
 * read of a persisted table — signals are computed live, on every
 * request, from whatever trades/scores are already in Postgres (see
 * `docs/smart-money-signals.md` §5 for why persistence is deferred).
 * Still read-only: no ingestion, no writes, nothing computed here is
 * ever stored.
 */
import { Router } from 'express';
import { gatherSignalDetectionInput } from '../../analytics/signals/gatherSignalDetectionInput.js';
import {
  detectSmartMoneySignals,
  type DetectSmartMoneySignalsConfig,
} from '../../analytics/signals/detectSmartMoneySignals.js';
import { firstQueryString, parseLimitParam } from '../queryParams.js';

export const signalsRouter = Router();

const DEFAULT_LOOKBACK_MINUTES = 60;
const MAX_LOOKBACK_MINUTES = 1440;
const DEFAULT_MIN_SMART_SCORE = 35;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ParsePositiveIntResult = { ok: true; value: number } | { ok: false; message: string };

function parsePositiveIntParam(
  value: unknown,
  paramName: string,
  defaultValue: number,
  maxValue: number,
): ParsePositiveIntResult {
  if (value === undefined) return { ok: true, value: defaultValue };

  const raw = firstQueryString(value);
  if (raw === undefined) {
    return { ok: false, message: `${paramName} must be a single value` };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, message: `${paramName} must be a positive integer` };
  }

  return { ok: true, value: Math.min(parsed, maxValue) };
}

signalsRouter.get('/recent', async (req, res) => {
  const lookbackResult = parsePositiveIntParam(
    req.query['lookbackMinutes'],
    'lookbackMinutes',
    DEFAULT_LOOKBACK_MINUTES,
    MAX_LOOKBACK_MINUTES,
  );
  if (!lookbackResult.ok) {
    res.status(400).json({ error: 'invalid_lookback_minutes', message: lookbackResult.message });
    return;
  }

  const minSmartScoreRaw = firstQueryString(req.query['minSmartScore']);
  let minSmartScore = DEFAULT_MIN_SMART_SCORE;
  if (minSmartScoreRaw !== undefined) {
    const parsed = Number(minSmartScoreRaw);
    if (!Number.isFinite(parsed)) {
      res
        .status(400)
        .json({ error: 'invalid_min_smart_score', message: 'minSmartScore must be a number' });
      return;
    }
    minSmartScore = parsed;
  }

  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const input = await gatherSignalDetectionInput(lookbackResult.value);
  const detectorConfig: DetectSmartMoneySignalsConfig = { minSmartScore };
  const signals = detectSmartMoneySignals(input, detectorConfig).slice(0, limitResult.value);

  res.json({
    lookbackMinutes: lookbackResult.value,
    minSmartScore,
    tradesConsidered: input.trades.length,
    signals,
  });
});
