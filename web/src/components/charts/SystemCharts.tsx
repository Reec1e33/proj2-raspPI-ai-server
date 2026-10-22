import { formatPercent, formatRate, formatTemperature } from '../../lib/format';
import type { Sample } from '../../lib/samples';
import { PERCENT_SCALE, byteRateScale, temperatureScale } from '../../lib/scale';
import { TimeSeriesChart } from './TimeSeriesChart';

interface SystemChartsProps {
  history: Sample[];
  windowMs: number;
}

const percentTick = (value: number) => `${value}%`;

/**
 * The four live charts. Each measure gets its own chart and y-axis (no dual
 * axes). This module pulls in Recharts and is loaded lazily from App.
 */
export default function SystemCharts({ history, windowMs }: SystemChartsProps) {
  const minutes = Math.round(windowMs / 60_000);
  const temperatures = history.flatMap((s) => (s.temperatureC === null ? [] : [s.temperatureC]));
  const network = byteRateScale(
    Math.max(0, ...history.map((s) => Math.max(s.rxBytesPerSecond ?? 0, s.txBytesPerSecond ?? 0))),
  );
  const networkTick = (value: number) =>
    value === 0 ? '0' : `${Number((value / network.unitBytes).toFixed(2))} ${network.unit}/s`;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <TimeSeriesChart
        title="CPU usage"
        description={`All cores, last ${minutes} minutes`}
        data={history}
        series={[{ key: 'cpuPercent', label: 'CPU usage', color: 'var(--series-1)' }]}
        scale={PERCENT_SCALE}
        formatValue={(v) => formatPercent(v)}
        formatTick={percentTick}
        windowMs={windowMs}
      />
      <TimeSeriesChart
        title="CPU temperature"
        description={`SoC sensor, last ${minutes} minutes`}
        data={history}
        series={[{ key: 'temperatureC', label: 'Temperature', color: 'var(--series-1)' }]}
        scale={temperatureScale(temperatures)}
        formatValue={formatTemperature}
        formatTick={(v) => `${v}°`}
        windowMs={windowMs}
        emptyMessage={
          history.length >= 2 && temperatures.length === 0
            ? 'This host reports no CPU temperature'
            : undefined
        }
      />
      <TimeSeriesChart
        title="Memory usage"
        description={`Used = total - available, last ${minutes} minutes`}
        data={history}
        series={[{ key: 'memoryPercent', label: 'Memory usage', color: 'var(--series-1)' }]}
        scale={PERCENT_SCALE}
        formatValue={(v) => formatPercent(v)}
        formatTick={percentTick}
        windowMs={windowMs}
      />
      <TimeSeriesChart
        title="Network throughput"
        description={`All interfaces, last ${minutes} minutes`}
        data={history}
        series={[
          { key: 'rxBytesPerSecond', label: 'In', color: 'var(--series-1)' },
          { key: 'txBytesPerSecond', label: 'Out', color: 'var(--series-2)' },
        ]}
        scale={network}
        formatValue={formatRate}
        formatTick={networkTick}
        windowMs={windowMs}
        yAxisWidth={72}
      />
    </div>
  );
}
