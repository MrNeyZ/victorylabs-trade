/**
 * SQL pattern-escaping helper shared across `db/repositories/*.ts` files
 * that build `LIKE`/`ILIKE` patterns from user-supplied text (currently
 * only `searchRepository.ts`, Phase 5.1). `%` and `_` are wildcards in a
 * `LIKE` pattern; a literal search term containing either (a market
 * event title with an underscore, say) must have them escaped or they'd
 * silently match more than the user typed. `\` is escaped first so an
 * already-escaped `%`/`_` in the input can't be re-interpreted.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
