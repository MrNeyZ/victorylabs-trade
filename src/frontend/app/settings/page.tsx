'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '../components/SectionCard';
import {
  useNotificationSettings,
  playNotificationSound,
  type SignalType,
} from '../lib/notifications';

const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  whale_trade: 'Whale Trades',
  smart_wallet_trade: 'Smart Wallet Trades',
  elite_wallet_trade: 'Elite Wallet Trades',
  market_consensus: 'Market Consensus',
};

const SIGNAL_TYPES = Object.keys(SIGNAL_TYPE_LABELS) as SignalType[];

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

const PERMISSION_LABEL: Record<PermissionState, string> = {
  default: 'Not requested',
  granted: 'Granted',
  denied: 'Denied',
  unsupported: 'Not supported by this browser',
};

/**
 * Notification settings — Phase 5.3. Everything here writes to
 * `localStorage` via `useNotificationSettings()`
 * (`../lib/notifications.ts`) — no backend call, no new table.
 *
 * `Notification.requestPermission()` is called from exactly one place
 * in this whole app: `handleEnable` below, itself only reachable by a
 * direct click on the "Enable Notifications" button. Nothing calls it
 * on mount/automatically — `NotificationWatcher.tsx` (the background
 * poller) only ever *reads* `Notification.permission`, per this phase's
 * "never ask automatically" rule.
 */
export default function SettingsPage() {
  const { settings, updateSettings, toggleNotifyOn } = useNotificationSettings();
  const [permission, setPermission] = useState<PermissionState>('default');
  const [testSentAt, setTestSentAt] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);
  }, []);

  function handleEnable() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    void Notification.requestPermission().then((result) => {
      setPermission(result);
      updateSettings({ enabled: result === 'granted' });
    });
  }

  function handleDisable() {
    updateSettings({ enabled: false });
  }

  function handleTestNotification() {
    if (permission !== 'granted') return;
    new Notification('🔔 Test Notification', {
      body: 'Notifications are working correctly.',
    });
    if (settings.soundEnabled) playNotificationSound();
    setTestSentAt(Date.now());
  }

  const isActive = settings.enabled && permission === 'granted';

  return (
    <main>
      <h1>Settings</h1>

      <div className="dashboard-grid">
        <SectionCard title="Browser Notifications">
          <p className="settings-status">
            Permission: <strong>{PERMISSION_LABEL[permission]}</strong>
          </p>
          <p className="settings-status">
            Desktop notifications: <strong>{isActive ? 'Enabled' : 'Disabled'}</strong>
          </p>

          {permission === 'denied' && (
            <p className="settings-hint settings-hint-error">
              Notifications are blocked for this site. Enable them in your browser&apos;s site
              settings, then reload this page.
            </p>
          )}

          {permission === 'unsupported' && (
            <p className="settings-hint settings-hint-error">
              This browser doesn&apos;t support the Notification API.
            </p>
          )}

          {permission !== 'denied' && permission !== 'unsupported' && (
            <div className="settings-actions">
              {isActive ? (
                <button type="button" className="refresh-button" onClick={handleDisable}>
                  Disable Notifications
                </button>
              ) : (
                <button type="button" className="refresh-button" onClick={handleEnable}>
                  Enable Notifications
                </button>
              )}
              {permission === 'granted' && (
                <button type="button" className="refresh-button" onClick={handleTestNotification}>
                  Send Test Notification
                </button>
              )}
              {testSentAt !== null && <span className="page-meta">Test notification sent.</span>}
            </div>
          )}

          <div className="settings-section">
            <div className="settings-section-label">Notify on</div>
            {SIGNAL_TYPES.map((type) => (
              <label key={type} className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.notifyOn[type]}
                  onChange={() => toggleNotifyOn(type)}
                />
                {SIGNAL_TYPE_LABELS[type]}
              </label>
            ))}
          </div>

          <div className="settings-section">
            <label className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onChange={() => updateSettings({ soundEnabled: !settings.soundEnabled })}
              />
              Play notification sound
            </label>
          </div>
        </SectionCard>
      </div>
    </main>
  );
}
