import { Cpu } from 'lucide-react';
import type { CpuStats } from '../api/types';
import { formatFrequency, formatPercent } from '../lib/format';
import { Meter } from './Meter';
import { EmptyState, Panel } from './Panel';

interface CoreBarsProps {
  cpu: CpuStats | undefined;
}

/** Per-core usage. Cores are nominal, so every bar uses the same series hue. */
export function CoreBars({ cpu }: CoreBarsProps) {
  const load = cpu?.load_average;
  return (
    <Panel
      title="CPU cores"
      description={
        cpu && load
          ? `${cpu.cores} cores · ${formatFrequency(cpu.frequency_mhz)} · load ${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)}`
          : 'Per-core usage'
      }
    >
      {cpu && cpu.per_core_percent.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {cpu.per_core_percent.map((percent, index) => (
            <li key={index} className="grid grid-cols-[3.5rem_1fr_3.5rem] items-center gap-3">
              <span className="text-xs text-ink-secondary">Core {index}</span>
              <Meter
                value={percent}
                label={`Core ${index} usage`}
                valueText={formatPercent(percent)}
              />
              <span className="text-right text-xs text-ink tabular-nums">
                {formatPercent(percent)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={Cpu} title="No per-core data yet" />
      )}
    </Panel>
  );
}
