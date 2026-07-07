'use client';

import { useEffect } from 'react';
import {
  useNotificationSettings,
  getSeenSignalIds,
  markSignalsSeen,
  buildNotificationContent,
  playNotificationSound,
  type NotifiableSignal,
} from '../lib/notifications';

/** Same fallback/reasoning as every other page/component in this app. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4100';
const POLL_INTERVAL_MS = 30_000;
const POLL_LIMIT = 20;

/**
 * Renders nothing — a background poller mounted once in `layout.tsx`
 * (Phase 5.3), the same "invisible global component" pattern
 * `GlobalSearch`'s dropdown-close listener already uses, just with no
 * visible markup at all here.
 *
 * Does *no* network activity whatsoever unless the user has both
 * explicitly enabled notifications in Settings AND actually granted the
 * real browser permission — per this phase's "never poll unless
 * necessary" and "never ask for permission automatically" rules, this
 * component only ever *reads* `Notification.permission`, it never calls
 * `requestPermission()` itself (that only happens from a direct click on
 * `settings/page.tsx`'s Enable button).
 *
 * No SSE stream carries signals (only `/api/trades/stream` exists, and
 * that's raw trades, not detected signals) — polling
 * `GET /api/signals/recent` every 30s is the "otherwise" branch this
 * phase's brief itself calls out, not a fallback of convenience.
 */
export function NotificationWatcher() {
  const { settings } = useNotificationSettings();

  useEffect(() => {
    if (!settings.enabled) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/signals/recent?source=persisted&limit=${POLL_LIMIT}`,
        );
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as { signals: NotifiableSignal[] };
        const signals = payload.signals;

        const seenIds = getSeenSignalIds();
        const seenSet = new Set(seenIds);
        // First-ever poll (no history in localStorage yet): seed the seen
        // set silently rather than firing one notification per existing
        // signal the instant notifications are turned on.
        const isFirstEverPoll = seenIds.length === 0;
        const newSignals = signals.filter((signal) => !seenSet.has(signal.id));

        if (!isFirstEverPoll) {
          for (const signal of newSignals) {
            if (!settings.notifyOn[signal.type]) continue;
            const content = buildNotificationContent(signal);
            new Notification(content.title, { body: content.body });
            if (settings.soundEnabled) playNotificationSound();
          }
        }

        markSignalsSeen(signals.map((signal) => signal.id));
      } catch {
        // Network hiccup — next 30s poll will retry; nothing to surface
        // to the user for a silent background watcher.
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [settings.enabled, settings.notifyOn, settings.soundEnabled]);

  return null;
}
