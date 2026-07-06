import type { ReactNode } from 'react';

/** The `<section className="card"><h2>...</h2>...</section>` wrapper every dashboard/wallet-detail card used, extracted so the card chrome can't drift between sections. */
export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
