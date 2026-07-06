/**
 * Manual refresh + "last updated" strip — Phase 3.10. Shared by the
 * dashboard and wallet-detail pages (the two pages this phase's brief
 * asks for a refresh button on); the live feed doesn't use this — it's
 * SSE-driven and always live, so a "last updated" timestamp lives
 * directly next to its connection-status badge instead (see
 * `app/page.tsx`).
 *
 * Deliberately dumb: it takes an already-formatted `metaText` string
 * rather than a raw `Date`, so this component doesn't need to know
 * anything about a particular page's own idea of "what else belongs in
 * the meta line" (the dashboard also shows `lookbackMinutes`; the wallet
 * page doesn't).
 */
export interface RefreshBarProps {
  metaText: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  /** Set only when a *background* refresh (not the initial load) fails — the page keeps showing its last-good data underneath this. */
  refreshError?: string | null;
}

export function RefreshBar({ metaText, isRefreshing, onRefresh, refreshError }: RefreshBarProps) {
  return (
    <div className="refresh-bar">
      <span className="page-meta">
        {metaText}
        {isRefreshing ? ' · refreshing…' : ''}
      </span>
      <button type="button" className="refresh-button" onClick={onRefresh} disabled={isRefreshing}>
        {isRefreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      {refreshError && (
        <span className="error-state refresh-error">Refresh failed: {refreshError}</span>
      )}
    </div>
  );
}
