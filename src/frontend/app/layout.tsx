import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { GlobalSearch } from './components/GlobalSearch';
import { NotificationWatcher } from './components/NotificationWatcher';
import { ConnectionStatusBadge } from './components/ConnectionStatusBadge';
import './globals.css';

export const metadata: Metadata = {
  title: 'VictoryLabs Trade',
  description: 'Read-only smart-money tracking for Jupiter Prediction',
};

/**
 * Shared nav across every page (Phase 3.8). Lives here, not inside
 * `app/page.tsx`, specifically so the existing live-feed page doesn't
 * need to change at all to gain navigation — this file wraps it, it
 * doesn't touch it. Plain links, no active-route highlighting: that
 * would need `usePathname()` (a Client Component), which would force
 * this layout to give up its `metadata` export (Server-Component-only in
 * the App Router) — not worth it for a two-link nav bar.
 *
 * `<GlobalSearch />` (Phase 5.1), `<NotificationWatcher />` (Phase 5.3,
 * renders nothing — a background poller), and `<ConnectionStatusBadge />`
 * (Phase 5.5, the shared realtime stream's live/reconnecting indicator)
 * are themselves Client Components (`'use client'`), but rendering one as
 * a *child* of a Server Component doesn't force the parent to become one
 * too — this file stays a Server Component and keeps its `metadata`
 * export exactly as before.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="site-nav">
          <Link href="/">Live Feed</Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/watchlist">Watchlist</Link>
          <Link href="/settings">Settings</Link>
          <GlobalSearch />
          <ConnectionStatusBadge />
        </nav>
        <NotificationWatcher />
        {children}
      </body>
    </html>
  );
}
