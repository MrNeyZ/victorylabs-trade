/**
 * Browser notification settings + "which signals have we already
 * notified about" bookkeeping — Phase 5.3. Everything here is
 * `localStorage`, same "frontend-only, no backend persistence" rule
 * `../watchlist.ts` (Phase 5.2) already follows, and the same
 * cross-component-sync pattern (a custom event, since the native
 * `storage` event only fires in *other* tabs).
 *
 * This module never calls the real `Notification` API itself (that's
 * `NotificationWatcher.tsx`/`settings/page.tsx`, since only Client
 * Components should touch browser-only globals directly) — it's pure
 * localStorage plumbing plus the notification *content* formatting,
 * which is presentation logic, not I/O, and is unit-testable in
 * isolation from `Notification` itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { shortenPubkey, formatUsd } from './format';

const SETTINGS_KEY = 'vltrade:notification-settings';
const SEEN_SIGNALS_KEY = 'vltrade:notifications-seen-signal-ids';
const SETTINGS_CHANGE_EVENT = 'vltrade:notification-settings-changed';
/** Bounds how many signal ids `localStorage` keeps — `/api/signals/recent` only ever returns *recent* signals anyway, so an id aged out of this window can never reappear and needs to be "remembered" forever. */
const MAX_SEEN_SIGNAL_IDS = 300;

export type SignalType =
  'smart_wallet_trade' | 'elite_wallet_trade' | 'market_consensus' | 'whale_trade';

export interface NotificationSettings {
  enabled: boolean;
  notifyOn: Record<SignalType, boolean>;
  soundEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  notifyOn: {
    whale_trade: true,
    smart_wallet_trade: true,
    elite_wallet_trade: true,
    market_consensus: true,
  },
  soundEnabled: false,
};

function isNotificationSettings(value: unknown): value is NotificationSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['enabled'] !== 'boolean') return false;
  if (typeof candidate['soundEnabled'] !== 'boolean') return false;
  const notifyOn = candidate['notifyOn'];
  if (typeof notifyOn !== 'object' || notifyOn === null) return false;
  const notifyOnCandidate = notifyOn as Record<string, unknown>;
  return (
    ['whale_trade', 'smart_wallet_trade', 'elite_wallet_trade', 'market_consensus'] as const
  ).every((key) => typeof notifyOnCandidate[key] === 'boolean');
}

export function readNotificationSettings(): NotificationSettings {
  if (typeof window === 'undefined') return DEFAULT_NOTIFICATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return DEFAULT_NOTIFICATION_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    return isNotificationSettings(parsed) ? parsed : DEFAULT_NOTIFICATION_SETTINGS;
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

function writeNotificationSettings(settings: NotificationSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
}

/** Every component reading/changing notification settings uses this — same cross-instance sync reasoning as `useWatchlist()`. */
export function useNotificationSettings() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);

  useEffect(() => {
    setSettings(readNotificationSettings());
    function handleChange() {
      setSettings(readNotificationSettings());
    }
    window.addEventListener(SETTINGS_CHANGE_EVENT, handleChange);
    window.addEventListener('storage', handleChange);
    return () => {
      window.removeEventListener(SETTINGS_CHANGE_EVENT, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  const updateSettings = useCallback((update: Partial<NotificationSettings>) => {
    const current = readNotificationSettings();
    writeNotificationSettings({ ...current, ...update });
  }, []);

  const toggleNotifyOn = useCallback((type: SignalType) => {
    const current = readNotificationSettings();
    writeNotificationSettings({
      ...current,
      notifyOn: { ...current.notifyOn, [type]: !current.notifyOn[type] },
    });
  }, []);

  return { settings, updateSettings, toggleNotifyOn };
}

/**
 * `NotificationWatcher`'s "have we already notified about this
 * signal?" memory — a plain id list capped to `MAX_SEEN_SIGNAL_IDS`,
 * not a `Set` (JSON can't round-trip a `Set` through `localStorage`
 * directly, and the list is small enough that array `includes`/dedup is
 * fine at this scale).
 */
export function getSeenSignalIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SEEN_SIGNALS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export function markSignalsSeen(ids: string[]): void {
  if (typeof window === 'undefined' || ids.length === 0) return;
  const current = getSeenSignalIds();
  const merged = [...current, ...ids.filter((id) => !current.includes(id))];
  const trimmed = merged.slice(Math.max(0, merged.length - MAX_SEEN_SIGNAL_IDS));
  window.localStorage.setItem(SEEN_SIGNALS_KEY, JSON.stringify(trimmed));
}

/** Mirrors the backend's `PersistedSignal` (`src/backend/db/repositories/signalsRepository.ts`) — only the fields notification content actually needs. */
export interface NotifiableSignal {
  id: string;
  type: SignalType;
  walletPubkeys: string[];
  eventTitle: string | null;
  side: 'yes' | 'no' | null;
  amountUsd: string | null;
}

export interface NotificationContent {
  title: string;
  body: string;
}

/**
 * A short, synthesized two-tone beep via the Web Audio API — no audio
 * asset file needed (this project has none, and adding a binary just
 * for this felt heavier than a dozen lines of oscillator code). Safe to
 * call from anywhere; silently no-ops if `AudioContext` isn't available
 * (SSR, or a browser without Web Audio support).
 */
export function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  const context = new AudioContextClass();
  const now = context.currentTime;

  [880, 1320].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const start = now + index * 0.12;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  });

  // AudioContexts aren't garbage-collected automatically — close it once
  // both tones have finished playing.
  setTimeout(() => void context.close(), 400);
}

/**
 * Builds the exact title/body this phase's brief specifies per signal
 * type. `elite_wallet_trade` has no example format in the brief (only
 * whale/smart-wallet/consensus do) — it's structurally the same signal
 * shape as `smart_wallet_trade` (a single wallet's trade, just against a
 * stricter Smart Score bar, per `docs/smart-money-signals.md`), so it
 * reuses that same Wallet/Market body layout with its own title.
 */
export function buildNotificationContent(signal: NotifiableSignal): NotificationContent {
  const marketLine = signal.eventTitle ?? 'Unknown market';
  const sideLabel = signal.side ? signal.side.toUpperCase() : '';

  switch (signal.type) {
    case 'whale_trade':
      return {
        title: '🐋 Whale Trade',
        body: `${formatUsd(signal.amountUsd)} ${sideLabel}\n${marketLine}`,
      };
    case 'smart_wallet_trade':
      return {
        title: '🧠 Smart Wallet',
        body: `Wallet:\n${shortenPubkey(signal.walletPubkeys[0] ?? 'unknown')}\n\nMarket:\n${marketLine}`,
      };
    case 'elite_wallet_trade':
      return {
        title: '👑 Elite Wallet',
        body: `Wallet:\n${shortenPubkey(signal.walletPubkeys[0] ?? 'unknown')}\n\nMarket:\n${marketLine}`,
      };
    case 'market_consensus':
      return {
        title: '🔥 Market Consensus',
        body: `${signal.walletPubkeys.length} smart wallets bought ${sideLabel}\n\nMarket:\n${marketLine}`,
      };
  }
}
