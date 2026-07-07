/**
 * Trailing-edge throttle for a callback, capped at once per `intervalMs`
 * — Phase 5.5 follow-up. Dedicated to `dashboard/page.tsx`'s live
 * refresh only: the dashboard's sections are terminal-wide aggregates
 * (not scoped to one wallet/market like the detail pages), so refetching
 * on the same ~3s debounce as those pages was needlessly aggressive for
 * an "at a glance" view. `./useDebouncedCallback.ts` is untouched and
 * still backs the wallet/market/watchlist pages exactly as before.
 *
 * Unlike a debounce (which keeps pushing the fire time back on every
 * call, so a *continuous* stream of events can delay it indefinitely),
 * this guarantees a call at most every `intervalMs` for as long as
 * events keep arriving — but only ever fires on the trailing edge: the
 * first call in an idle period schedules a fire `intervalMs` later
 * rather than running immediately, and every call in between just marks
 * "there's a refresh owed" without resetting that timer. If nothing
 * calls it again before the timer fires, it fires once and then goes
 * fully idle (no dangling repeating timer) — matches "if no trades
 * arrive, nothing should refresh".
 */
import { useCallback, useEffect, useRef } from 'react';

export function useThrottledCallback(callback: () => void, intervalMs: number): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  const scheduleTick = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      // Only fire — and only re-arm the next window — if something
      // actually asked for a refresh since the last tick. Otherwise stop
      // here: no dangling timer chain once activity quiets down.
      if (pendingRef.current) {
        pendingRef.current = false;
        callbackRef.current();
        scheduleTick();
      }
    }, intervalMs);
  }, [intervalMs]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(() => {
    pendingRef.current = true;
    if (timeoutRef.current === null) {
      scheduleTick();
    }
  }, [scheduleTick]);
}
