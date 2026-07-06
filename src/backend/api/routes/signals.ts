/**
 * GET /api/signals/recent — Smart Money Signals, Phase 3.5 + 3.6.
 *
 * Default (`source=persisted`): reads the `smart_money_signals` table
 * (`signalsRepository.getRecentSignals`) — whatever
 * `analytics:signals:persist` has already detected and written. A real
 * read of a persisted table, same as `/api/scores/latest`.
 *
 * `source=live`: recomputes on this request, exactly like this route
 * behaved before Phase 3.6 — fetches the current trade/score window and
 * runs the pure detector fresh, nothing persisted or read from
 * `smart_money_signals`.
 *
 * Still fully read-only either way: no ingestion is triggered, and the
 * `live` mode never writes what it computes (only
 * `analytics:signals:persist` writes to `smart_money_signals`).
 */
import { Router } from 'express';
import { gatherSignalDetectionInput } from '../../analytics/signals/gatherSignalDetectionInput.js';
import {
  detectSmartMoneySignals,
  type DetectSmartMoneySignalsConfig,
} from '../../analytics/signals/detectSmartMoneySignals.js';
import { getRecentSignals } from '../../db/repositories/signalsRepository.js';
import { firstQueryString, parseLimitParam, parsePositiveIntParam } from '../queryParams.js';

export const signalsRouter = Router();

const DEFAULT_LOOKBACK_MINUTES = 60;
const MAX_LOOKBACK_MINUTES = 1440;
const DEFAULT_MIN_SMART_SCORE = 35;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type SignalSource = 'persisted' | 'live';

function isSignalSource(value: string): value is SignalSource {
  return value === 'persisted' || value === 'live';
}

signalsRouter.get('/recent', async (req, res) => {
  const sourceParam = firstQueryString(req.query['source']) ?? 'persisted';
  if (!isSignalSource(sourceParam)) {
    res
      .status(400)
      .json({ error: 'invalid_source', message: 'source must be one of: persisted, live' });
    return;
  }

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

  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  if (sourceParam === 'persisted') {
    const signals = await getRecentSignals({
      lookbackMinutes: lookbackResult.value,
      limit: limitResult.value,
    });

    res.json({
      source: 'persisted',
      lookbackMinutes: lookbackResult.value,
      limit: limitResult.value,
      signals,
    });
    return;
  }

  // source === 'live'
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

  const input = await gatherSignalDetectionInput(lookbackResult.value);
  const detectorConfig: DetectSmartMoneySignalsConfig = { minSmartScore };
  const signals = detectSmartMoneySignals(input, detectorConfig).slice(0, limitResult.value);

  res.json({
    source: 'live',
    lookbackMinutes: lookbackResult.value,
    minSmartScore,
    limit: limitResult.value,
    tradesConsidered: input.trades.length,
    signals,
  });
});
