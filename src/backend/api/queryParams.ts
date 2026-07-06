/**
 * Small query-string parsing helpers shared across `routes/*.ts`. Express
 * types `req.query[key]` as `undefined | string | string[] | ParsedQs |
 * ParsedQs[]` — these narrow that down to the plain string/number shapes
 * this read-only API actually needs, rejecting anything else explicitly
 * rather than silently coercing.
 */

export function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export type ParseLimitResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Parses any positive-integer query param, clamped to `maxValue`. Absent
 * is fine (returns `defaultValue`); present-but-invalid is a hard error.
 * `paramName` is used only to phrase the error message correctly (e.g.
 * `lookbackMinutes must be a positive integer`, not a generic/misleading
 * `limit must be...` for a differently-named param) — originally written
 * inline in `routes/signals.ts` for its `lookbackMinutes` param, promoted
 * here once `routes/dashboard.ts` needed the exact same thing for a
 * second, differently-named param.
 */
export function parsePositiveIntParam(
  value: unknown,
  paramName: string,
  defaultValue: number,
  maxValue: number,
): ParseLimitResult {
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

/** `parsePositiveIntParam` fixed to `paramName: 'limit'` — kept as its own function since `limit` appears on nearly every list endpoint in this project and callers shouldn't have to repeat the param name. */
export function parseLimitParam(
  value: unknown,
  defaultValue: number,
  maxValue: number,
): ParseLimitResult {
  return parsePositiveIntParam(value, 'limit', defaultValue, maxValue);
}
