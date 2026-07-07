/**
 * Trailing-edge debounce for a callback — Phase 5.5. Used to coalesce a
 * burst of live trade events (one shared stream, potentially many trades
 * per second across every open page) into a single refetch per page
 * instead of one per trade, per this phase's "do not full-refresh on
 * every event" spirit. No max-wait fallback: a live trade burst settles
 * on its own (the poller behind `/api/trades/stream` only sends what's
 * new every 5s), so there's no realistic case where this never fires.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useDebouncedCallback(callback: () => void, delayMs: number): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => callbackRef.current(), delayMs);
  }, [delayMs]);
}
