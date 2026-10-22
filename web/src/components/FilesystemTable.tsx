import { HardDrive } from 'lucide-react';
import type { FilesystemStats } from '../api/types';
import { formatBytes, formatPercent } from '../lib/format';
import { DISK_THRESHOLDS, levelFor } from '../lib/thresholds';
import { LevelIndicator } from './LevelIndicator';
import { Meter } from './Meter';
import { EmptyState, Panel } from './Panel';

const FILL = {
  good: 'var(--series-1)',
  warning: 'var(--status-warning)',
  critical: 'var(--status-critical)',
  unknown: 'var(--ink-muted)',
} as const;

interface FilesystemTableProps {
  filesystems: FilesystemStats[] | undefined;
}

export function FilesystemTable({ filesystems }: FilesystemTableProps) {
  return (
    <Panel
      title="Filesystems"
      description={`Warning at ${DISK_THRESHOLDS.warning}%, critical at ${DISK_THRESHOLDS.critical}%`}
    >
      {filesystems && filesystems.length > 0 ? (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-xs">
            <thead className="text-ink-secondary">
              <tr className="border-b border-line">
                <th scope="col" className="px-1 py-2 font-medium">
                  Mount
                </th>
                <th scope="col" className="px-1 py-2 text-right font-medium">
                  Free
                </th>
                <th scope="col" className="px-1 py-2 text-right font-medium">
                  Size
                </th>
                <th scope="col" className="w-1/2 px-1 py-2 font-medium">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody className="whitespace-nowrap tabular-nums">
              {filesystems.map((fs) => {
                const level = levelFor(fs.usage_percent, DISK_THRESHOLDS);
                return (
                  <tr key={fs.mountpoint} className="border-b border-line last:border-0">
                    <th scope="row" className="max-w-32 truncate px-1 py-2.5 font-mono font-normal">
                      {fs.mountpoint}
                    </th>
                    <td className="px-1 py-2.5 text-right">{formatBytes(fs.available_bytes)}</td>
                    <td className="px-1 py-2.5 text-right text-ink-secondary">
                      {formatBytes(fs.total_bytes)}
                    </td>
                    <td className="px-1 py-2.5">
                      <div className="flex items-center gap-2">
                        <Meter
                          className="flex-1"
                          value={fs.usage_percent}
                          label={`${fs.mountpoint} usage`}
                          valueText={formatPercent(fs.usage_percent)}
                          color={FILL[level]}
                        />
                        <span className="w-11 text-right">{formatPercent(fs.usage_percent)}</span>
                        {(level === 'warning' || level === 'critical') && (
                          <LevelIndicator
                            level={level}
                            label={level === 'critical' ? 'Critical' : 'High'}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={HardDrive} title="No filesystem data yet" />
      )}
    </Panel>
  );
}
