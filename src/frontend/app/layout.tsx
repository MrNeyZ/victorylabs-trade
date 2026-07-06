import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
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
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="site-nav">
          <Link href="/">Live Feed</Link>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
