import { Loader2, Radio, TimerOff, WifiOff, type LucideIcon } from 'lucide-react';
import type { ConnectionStatus } from '../hooks/useSystemStream';
import { formatClock } from '../lib/format';

const BADGE: Record<ConnectionStatus, { icon: LucideIcon; tone: string; label: string }> = {
  live: { icon: Radio, tone: 'text-good', label: 'Live' },
  connecting: { icon: Loader2, tone: 'text-warning animate-spin', label: 'Connecting' },
  stale: { icon: TimerOff, tone: 'text-warning', label: 'Stale' },
  offline: { icon: WifiOff, tone: 'text-critical', label: 'Offline' },
};

/** Header pill for the telemetry stream; announced politely when it changes. */
export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const { icon: Icon, tone, label } = BADGE[status];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink"
    >
      <Icon aria-hidden className={`size-3.5 ${tone}`} />
      {label}
    </span>
  );
}

interface ConnectionNoticeProps {
  status: ConnectionStatus;
  error: string | null;
  /** `collected_at` of the last snapshot, if any. */
  lastCollectedAt: string | undefined;
}

/** Explains an offline or stale stream; panels keep showing the last reading meanwhile. */
export function ConnectionNotice({ status, error, lastCollectedAt }: ConnectionNoticeProps) {
  const last = lastCollectedAt ? Date.parse(lastCollectedAt) : Number.NaN;
  if (status === 'stale') {
    return (
      <div className="panel flex items-start gap-3 px-4 py-3" data-testid="connection-notice">
        <TimerOff aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="text-sm">
          <p className="font-medium text-ink">Readings are not updating</p>
          <p className="text-xs text-ink-secondary">
            The API is connected, but the agent sent no new reading
            {Number.isNaN(last) ? '' : ` since ${formatClock(last)}`}. Check the agent container
            (docker compose logs agent).
          </p>
        </div>
      </div>
    );
  }
  if (status !== 'offline') return null;
  return (
    <div className="panel flex items-start gap-3 px-4 py-3" data-testid="connection-notice">
      <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
      <div className="text-sm">
        <p className="font-medium text-ink">
          {/* The reason (API unreachable, or the agent down behind a working API) is below. */}
          {Number.isNaN(last) ? 'No live data yet' : 'Live data paused'}
        </p>
        <p className="text-xs text-ink-secondary">
          {error ?? 'Connection lost.'}{' '}
          {!Number.isNaN(last) && `Showing the last reading from ${formatClock(last)}. `}
          Reconnecting automatically.
        </p>
      </div>
    </div>
  );
}
