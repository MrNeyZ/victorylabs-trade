import type { SignalType } from '../lib/notifications';
import {
  LOOKBACK_OPTIONS,
  SIGNAL_TYPE_FILTER_OPTIONS,
  type DashboardFilters,
  type SortDirection,
} from '../lib/dashboardFilters';

export interface FilterBarProps {
  filters: DashboardFilters;
  isUpdating: boolean;
  onChange: (partial: Partial<DashboardFilters>) => void;
  onReset: () => void;
}

/**
 * Dashboard filter controls — Phase 5.4. Lookback drives a refetch
 * (`onChange` for it triggers `dashboard/page.tsx`'s load effect); signal
 * type / min score / sort are pure client-side re-filters of data already
 * on screen — see that page's derived `filtered*`/`sorted*` values.
 */
export function FilterBar({ filters, isUpdating, onChange, onReset }: FilterBarProps) {
  return (
    <div className="filter-bar">
      <label className="filter-field">
        <span>Lookback</span>
        <select
          value={filters.lookbackMinutes}
          onChange={(event) => onChange({ lookbackMinutes: Number(event.target.value) })}
        >
          {LOOKBACK_OPTIONS.map((option) => (
            <option key={option.minutes} value={option.minutes}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-field">
        <span>Signal Type</span>
        <select
          value={filters.signalType}
          onChange={(event) => onChange({ signalType: event.target.value as SignalType | 'all' })}
        >
          {SIGNAL_TYPE_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-field">
        <span>Min Smart Score</span>
        <input
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={filters.minSmartScore}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange({ minSmartScore: Number.isFinite(parsed) ? parsed : 0 });
          }}
        />
      </label>

      <label className="filter-field">
        <span>Sort</span>
        <select
          value={filters.sortDirection}
          onChange={(event) => onChange({ sortDirection: event.target.value as SortDirection })}
        >
          <option value="desc">Highest first</option>
          <option value="asc">Lowest first</option>
        </select>
      </label>

      <button type="button" className="reset-button" onClick={onReset}>
        Reset Filters
      </button>

      {isUpdating && <span className="page-meta filter-updating">Updating…</span>}
    </div>
  );
}
