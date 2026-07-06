/**
 * Small string-normalization helpers shared across `core/normalize*.ts`
 * files.
 */

/**
 * Empty-string identifier fields upstream (confirmed live, e.g.
 * `orderPubkey: ""` on settlement-only history events) are not meaningful
 * values — normalized to `null` rather than kept as `""`, so downstream
 * code can use plain nullish checks instead of also checking for empty
 * strings everywhere.
 */
export function nullIfEmpty(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}
