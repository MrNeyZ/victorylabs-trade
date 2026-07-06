/**
 * Precision-safe decimal string helpers. Upstream Jupiter Prediction amounts
 * are micro-USD integers encoded as strings specifically to survive u64/u128
 * magnitudes without float precision loss (see
 * docs/jupiter-prediction-discovery.md §3). Converting through `Number` at
 * any point — even just to divide by 1e6 — reintroduces exactly the
 * precision risk that encoding was designed to avoid, so this does the
 * unit shift with string/BigInt arithmetic only.
 */

const MICRO_USD_DECIMALS = 6;

/**
 * Converts a micro-USD integer string (e.g. `"4459073"`, `"-4718193"`) to an
 * actual-USD decimal string (e.g. `"4.459073"`, `"-4.718193"`), preserving
 * every digit exactly. Throws on anything that isn't an optionally-signed
 * integer string — a malformed value here means either upstream changed
 * shape or a normalization bug, and both should fail loudly rather than
 * silently produce a wrong dollar amount.
 */
export function microUsdToUsd(microUsd: string): string {
  const negative = microUsd.startsWith('-');
  const digits = negative ? microUsd.slice(1) : microUsd;

  if (!/^\d+$/.test(digits)) {
    throw new Error(`microUsdToUsd: expected an integer string, got ${JSON.stringify(microUsd)}`);
  }

  const padded = digits.padStart(MICRO_USD_DECIMALS + 1, '0');
  const integerPart = padded.slice(0, -MICRO_USD_DECIMALS);
  const fractionPart = padded.slice(-MICRO_USD_DECIMALS);
  const unsigned = `${integerPart}.${fractionPart}`;

  const isZero = /^0+$/.test(integerPart) && /^0+$/.test(fractionPart);
  return negative && !isZero ? `-${unsigned}` : unsigned;
}

/** Same as `microUsdToUsd`, but passes through `null`/`undefined` — for upstream fields documented (or empirically confirmed) as nullable. */
export function microUsdToUsdOrNull(microUsd: string | null | undefined): string | null {
  if (microUsd === null || microUsd === undefined) return null;
  return microUsdToUsd(microUsd);
}

const DECIMAL_SCALE = 6;

/**
 * Parses an already-converted USD decimal string (e.g. `"4.517686"`,
 * `"-8.404618"` — the domain-type shape, NOT upstream's micro-USD
 * integer strings) into a fixed-point integer scaled by 10^6, so summing
 * many of them can use exact `BigInt` addition instead of floating-point
 * `Number` addition. Used by `sumDecimalStrings`/`averageDecimalStrings`
 * (analytics aggregation — see `src/backend/analytics/`), which is the
 * first place in this project that needs to add several already-decimal
 * amounts together rather than just shifting one micro-USD integer.
 */
function decimalStringToScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '0', fractionPart = ''] = unsigned.split('.');

  if (!/^\d+$/.test(integerPart) || !/^\d*$/.test(fractionPart)) {
    throw new Error(
      `decimalStringToScaled: expected a decimal string, got ${JSON.stringify(value)}`,
    );
  }

  const scaledFraction = fractionPart.padEnd(DECIMAL_SCALE, '0').slice(0, DECIMAL_SCALE);
  const scaled = BigInt(integerPart + scaledFraction);
  return negative ? -scaled : scaled;
}

function scaledToDecimalString(scaled: bigint): string {
  const negative = scaled < 0n;
  const unsigned = negative ? -scaled : scaled;
  const padded = unsigned.toString().padStart(DECIMAL_SCALE + 1, '0');
  const integerPart = padded.slice(0, -DECIMAL_SCALE);
  const fractionPart = padded.slice(-DECIMAL_SCALE);
  const result = `${integerPart}.${fractionPart}`;
  return negative && scaled !== 0n ? `-${result}` : result;
}

/** Exact sum of decimal USD strings via scaled `BigInt` addition — `null`/`undefined` entries are skipped, not treated as zero-length input. Empty input sums to `"0.000000"`. */
export function sumDecimalStrings(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    total += decimalStringToScaled(value);
  }
  return scaledToDecimalString(total);
}

/**
 * Exact-sum, then integer-divide by count — average of decimal USD
 * strings. `null`/`undefined` entries are excluded from both the sum and
 * the count (not treated as zero). Returns `null` for empty input (there
 * is no meaningful average of zero values — distinct from `"0.000000"`,
 * which would claim a real, computed zero average).
 *
 * The final division truncates at the 6th decimal place (integer BigInt
 * division, not rounded) — a worst-case error under $0.000001, acceptable
 * for a display/analytics average that isn't fed back into further
 * money arithmetic.
 */
export function averageDecimalStrings(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => value !== null && value !== undefined);
  if (present.length === 0) return null;

  const total = present.reduce((sum, value) => sum + decimalStringToScaled(value), 0n);
  const average = total / BigInt(present.length);
  return scaledToDecimalString(average);
}
