import { ChartLine, ExternalLink, Server, Settings } from 'lucide-react';
import type { SystemSnapshot } from '../api/types';
import type { ConnectionStatus } from '../hooks/useSystemStream';
import { formatDuration } from '../lib/format';
import { ConnectionBadge } from './ConnectionStatus';

interface HeaderProps {
  snapshot: SystemSnapshot | null;
  status: ConnectionStatus;
  onOpenSettings: () => void;
}

export function Header({ snapshot, status, onOpenSettings }: HeaderProps) {
  const facts = snapshot
    ? [
        snapshot.platform.model ?? 'Unknown model',
        snapshot.platform.os,
        snapshot.platform.kernel && `Linux ${snapshot.platform.kernel}`,
        snapshot.platform.arch,
        `Up ${formatDuration(snapshot.uptime_seconds)}`,
      ].filter((fact): fact is string => Boolean(fact))
    : [];

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div className="flex min-w-[16rem] flex-1 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-white">
            <Server aria-hidden className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base leading-tight font-semibold">
              PiCloud
              <span className="font-normal text-ink-secondary">
                {' / '}
                {snapshot?.hostname ?? '…'}
              </span>
            </h1>
            <p className="truncate text-xs text-ink-secondary" title={facts.join(' · ')}>
              {facts.length > 0 ? facts.join(' · ') : 'Waiting for the first reading'}
            </p>
          </div>
        </div>
        <nav aria-label="Dashboard" className="flex items-center gap-1">
          <ConnectionBadge status={status} />
          <a className="btn-ghost" href="/grafana/" target="_blank" rel="noopener noreferrer">
            <ChartLine aria-hidden className="size-4" />
            Grafana
            <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <button type="button" className="btn-ghost" onClick={onOpenSettings}>
            <Settings aria-hidden className="size-4" />
            <span className="sr-only sm:not-sr-only">Settings</span>
          </button>
        </nav>
      </div>
    </header>
  );
}
