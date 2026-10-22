import type { Level } from '../lib/thresholds';
import { LevelIndicator } from './LevelIndicator';

export interface KpiTileProps {
  label: string;
  value: string;
  detail?: string;
  /** Omit for readings that have no thresholds (no status is shown). */
  status?: { level: Level; label: string };
}

/** A stat tile: label, headline value, then status and a short line of context. */
export function KpiTile({ label, value, detail, status }: KpiTileProps) {
  return (
    <article className="panel flex min-w-0 flex-col gap-1 p-4" data-level={status?.level}>
      <h3 className="truncate text-xs font-medium text-ink-secondary">{label}</h3>
      <p className="truncate text-2xl font-semibold text-ink" title={value}>
        {value}
      </p>
      {/* Wraps instead of truncating: a cut-off detail hides the number that matters. */}
      <div className="flex min-h-4 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {status && (
          <LevelIndicator level={status.level} label={status.label} className="shrink-0" />
        )}
        {detail && <p className="min-w-0 text-ink-secondary">{detail}</p>}
      </div>
    </article>
  );
}
