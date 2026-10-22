import type { SystemSnapshot } from '../api/types';
import {
  NO_VALUE,
  formatBytes,
  formatFrequency,
  formatPercent,
  formatRate,
  formatTemperature,
} from '../lib/format';
import { networkTotals, rootFilesystem } from '../lib/samples';
import {
  DISK_THRESHOLDS,
  type Level,
  TEMPERATURE_THRESHOLDS,
  type Thresholds,
  USAGE_THRESHOLDS,
  levelFor,
} from '../lib/thresholds';
import { summarizeThrottling } from '../lib/throttling';
import { KpiTile } from './KpiTile';

type LevelLabels = Record<Exclude<Level, 'unknown'>, string>;

const TEMPERATURE_LABELS: LevelLabels = { good: 'Normal', warning: 'Warm', critical: 'Hot' };
const USAGE_LABELS: LevelLabels = { good: 'Normal', warning: 'High', critical: 'Critical' };
const DISK_LABELS: LevelLabels = { good: 'OK', warning: 'Filling', critical: 'Almost full' };

function statusFor(
  value: number | null | undefined,
  thresholds: Thresholds,
  labels: LevelLabels,
  unknownLabel = 'No data',
): { level: Level; label: string } {
  const level = levelFor(value, thresholds);
  return { level, label: level === 'unknown' ? unknownLabel : labels[level] };
}

interface KpiGridProps {
  snapshot: SystemSnapshot | null;
}

export function KpiGrid({ snapshot }: KpiGridProps) {
  if (!snapshot) {
    const noData = { level: 'unknown' as const, label: 'No data' };
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {['CPU temp', 'CPU usage', 'Memory', 'Root disk', 'Network in', 'Throttling'].map(
          (label) => (
            <KpiTile key={label} label={label} value={NO_VALUE} status={noData} />
          ),
        )}
      </div>
    );
  }

  const { cpu, memory } = snapshot;
  const root = rootFilesystem(snapshot.filesystems);
  const network = networkTotals(snapshot.network);
  const throttle = summarizeThrottling(snapshot.throttling);
  const interfaces = snapshot.network.map((nic) => nic.interface).join(', ');

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="CPU temp"
        value={formatTemperature(cpu.temperature_celsius)}
        status={statusFor(
          cpu.temperature_celsius,
          TEMPERATURE_THRESHOLDS,
          TEMPERATURE_LABELS,
          'No sensor',
        )}
        detail={`Limits ${TEMPERATURE_THRESHOLDS.warning} / ${TEMPERATURE_THRESHOLDS.critical} °C`}
      />
      <KpiTile
        label="CPU usage"
        value={formatPercent(cpu.usage_percent)}
        status={statusFor(cpu.usage_percent, USAGE_THRESHOLDS, USAGE_LABELS)}
        detail={`Load ${cpu.load_average.one.toFixed(2)} · ${formatFrequency(cpu.frequency_mhz)}`}
      />
      <KpiTile
        label="Memory"
        value={formatPercent(memory.usage_percent)}
        status={statusFor(memory.usage_percent, USAGE_THRESHOLDS, USAGE_LABELS)}
        detail={`${formatBytes(memory.used_bytes)} of ${formatBytes(memory.total_bytes)}`}
      />
      <KpiTile
        label={root && root.mountpoint !== '/' ? `Disk ${root.mountpoint}` : 'Root disk'}
        value={formatPercent(root?.usage_percent)}
        status={statusFor(root?.usage_percent, DISK_THRESHOLDS, DISK_LABELS)}
        detail={root ? `${formatBytes(root.available_bytes)} free` : undefined}
      />
      <KpiTile
        label="Network in"
        value={formatRate(network.rx)}
        detail={`Out ${formatRate(network.tx)}${interfaces ? ` · ${interfaces}` : ''}`}
      />
      <KpiTile
        label="Throttling"
        value={throttle.value}
        status={{ level: throttle.level, label: throttle.levelLabel }}
        detail={throttle.detail}
      />
    </div>
  );
}
