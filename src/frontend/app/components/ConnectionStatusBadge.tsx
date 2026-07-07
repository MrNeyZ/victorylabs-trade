'use client';

import { useRealtimeStatus } from '../lib/realtimeTrades';

/**
 * Extracted from `app/page.tsx` (Phase 3.x) — Phase 5.5 mounts this once
 * in `layout.tsx`'s nav instead of only on the Live Feed page, since the
 * shared realtime connection (`../lib/realtimeTrades.ts`) now backs every
 * page's live updates, not just that one. `disconnected` is labeled
 * "Reconnecting…" here (it wasn't before) — that state is exactly the
 * browser's own automatic SSE retry after a drop, so this phase's "show a
 * reconnecting indicator" requirement is this same badge, not a second
 * one.
 */
const STATUS_LABEL = {
  connecting: 'Connecting',
  live: 'Live',
  disconnected: 'Reconnecting…',
  error: 'Error',
} as const;

export function ConnectionStatusBadge() {
  const status = useRealtimeStatus();

  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}
