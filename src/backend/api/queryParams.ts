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

/** Parses a `limit` query param into a positive integer, clamped to `maxValue`. Absent is fine (returns `defaultValue`); present-but-invalid is a hard error. */
export function parseLimitParam(
  value: unknown,
  defaultValue: number,
  maxValue: number,
): ParseLimitResult {
  if (value === undefined) return { ok: true, value: defaultValue };

  const raw = firstQueryString(value);
  if (raw === undefined) {
    return { ok: false, message: 'limit must be a single value' };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, message: 'limit must be a positive integer' };
  }

  return { ok: true, value: Math.min(parsed, maxValue) };
}
