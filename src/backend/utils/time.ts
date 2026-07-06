/** Small time-related helpers. */

/**
 * Floors a timestamp down to the nearest multiple of `bucketMs`. Used to
 * turn "now" into a stable bucket boundary so repeated ingestion runs
 * within the same window produce the exact same timestamp value instead
 * of a new one every run — the mechanism `ingestLeaderboards.ts` relies on
 * to avoid duplicate snapshot rows for the same (wallet, period) within a
 * short re-run window.
 */
export function floorToBucket(date: Date, bucketMs: number): Date {
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
