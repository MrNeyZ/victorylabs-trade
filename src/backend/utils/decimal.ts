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
