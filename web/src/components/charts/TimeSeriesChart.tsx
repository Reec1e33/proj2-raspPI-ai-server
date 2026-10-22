import { ChartLine, Table2 } from 'lucide-react';
import { useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { NO_VALUE, formatClock, formatShortClock } from '../../lib/format';
import type { Sample } from '../../lib/samples';
import { type Scale, timeTicks } from '../../lib/scale';
import { EmptyState, Panel } from '../Panel';

export type SampleKey = Exclude<keyof Sample, 't'>;

export interface SeriesSpec {
  key: SampleKey;
  label: string;
  /** CSS colour, normally a `var(--series-n)` token. */
  color: string;
}

interface TimeSeriesChartProps {
  title: string;
  description: string;
  data: Sample[];
  series: SeriesSpec[];
  scale: Scale;
  /** Full value for the header, tooltip and table, e.g. "51.2 °C". */
  formatValue: (value: number) => string;
  /** Compact y-axis tick label, e.g. "50°". */
  formatTick: (value: number) => string;
  windowMs: number;
  yAxisWidth?: number;
  /** Replaces the plot, e.g. when the host has no temperature sensor. */
  emptyMessage?: string;
}

/** Total height including the x-axis band, so the card never scrolls internally. */
const CHART_HEIGHT = 200;
const X_AXIS_HEIGHT = 24;
const MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
const MARGIN_END_LABELS = { ...MARGIN, right: 40 };
const PLOT_HEIGHT = CHART_HEIGHT - MARGIN.top - MARGIN.bottom - X_AXIS_HEIGHT;
const MIN_LABEL_GAP_PX = 14;
const TICK = { fill: 'var(--ink-muted)', fontSize: 11 };

/** End labels only help while they do not collide; otherwise the legend carries identity. */
function endLabelsFit(values: (number | null)[], scale: Scale): boolean {
  const px = values
    .filter((v): v is number => v !== null)
    .map((v) => ((v - scale.min) / (scale.max - scale.min)) * PLOT_HEIGHT)
    .sort((a, b) => a - b);
  return px.every((y, i) => i === 0 || y - (px[i - 1] ?? 0) >= MIN_LABEL_GAP_PX);
}

function renderEndLabel(text: string, lastIndex: number) {
  return (props: { index?: number; x?: number | string; y?: number | string }) => {
    const { index, x, y } = props;
    if (index !== lastIndex || typeof x !== 'number' || typeof y !== 'number') return null;
    return (
      <text x={x + 6} y={y} dy={4} fill="var(--ink-secondary)" fontSize={11}>
        {text}
      </text>
    );
  };
}

interface ChartTooltipProps extends Pick<TooltipContentProps, 'active' | 'payload' | 'label'> {
  series: SeriesSpec[];
  formatValue: (value: number) => string;
}

/** One readout for every series at the hovered time; values lead, names follow. */
function ChartTooltip({ active, payload, label, series, formatValue }: ChartTooltipProps) {
  if (!active || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-ink-secondary tabular-nums">{formatClock(Number(label))}</p>
      {series.map((s) => {
        const value = payload.find((entry) => entry.dataKey === s.key)?.value;
        return (
          <p key={s.key} className="flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            <span className="font-semibold text-ink tabular-nums">
              {typeof value === 'number' ? formatValue(value) : NO_VALUE}
            </span>
            <span className="text-ink-secondary">{s.label}</span>
          </p>
        );
      })}
    </div>
  );
}

/** The chart's accessible twin: every plotted value, newest first. */
function SeriesTable({
  title,
  data,
  series,
  formatValue,
}: Pick<TimeSeriesChartProps, 'title' | 'data' | 'series' | 'formatValue'>) {
  return (
    <div
      className="h-full overflow-auto rounded-lg border border-line"
      role="region"
      aria-label={`${title} data`}
      tabIndex={0}
    >
      <table className="w-full text-left text-xs tabular-nums">
        <caption className="sr-only">{title}, newest first</caption>
        <thead className="sticky top-0 bg-surface text-ink-secondary">
          <tr>
            <th scope="col" className="px-3 py-1.5 font-medium">
              Time
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-1.5 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((sample) => (
            <tr key={sample.t} className="border-t border-line">
              <th scope="row" className="px-3 py-1 font-normal text-ink-secondary">
                {formatClock(sample.t)}
              </th>
              {series.map((s) => {
                const value = sample[s.key];
                return (
                  <td key={s.key} className="px-3 py-1 text-right">
                    {value === null ? NO_VALUE : formatValue(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { title, description, data, series, scale, formatValue, formatTick, windowMs } = props;
  const [showTable, setShowTable] = useState(false);

  const latest = data.at(-1);
  const multiSeries = series.length > 1;
  const xMax = latest?.t ?? 0;
  const xMin = xMax - windowMs;
  const latestValues = series.map((s) => (latest ? latest[s.key] : null));
  const showEndLabels = multiSeries && endLabelsFit(latestValues, scale);
  const hasPlot = data.length >= 2 && !props.emptyMessage;
  const single = series[0];

  return (
    <Panel
      title={title}
      description={description}
      actions={
        <>
          {!multiSeries && single && (
            <span className="text-sm font-semibold text-ink tabular-nums">
              {latestValues[0] == null ? NO_VALUE : formatValue(latestValues[0])}
            </span>
          )}
          <button
            type="button"
            className="btn-ghost p-1.5"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            disabled={!hasPlot}
          >
            {showTable ? (
              <ChartLine aria-hidden className="size-4" />
            ) : (
              <Table2 aria-hidden className="size-4" />
            )}
            <span className="sr-only">Show {title} as a table</span>
          </button>
        </>
      }
    >
      {multiSeries && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-0.5 w-3 rounded-full"
                style={{ background: s.color }}
              />
              <span className="text-ink-secondary">{s.label}</span>
              <span className="font-semibold text-ink tabular-nums">
                {latestValues[i] == null ? NO_VALUE : formatValue(latestValues[i])}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div style={{ height: CHART_HEIGHT }}>
        {!hasPlot ? (
          <EmptyState
            icon={ChartLine}
            title={props.emptyMessage ?? 'Waiting for data'}
            detail={props.emptyMessage ? undefined : 'The chart starts after two readings.'}
            className="h-full"
          />
        ) : showTable ? (
          <SeriesTable title={title} data={data} series={series} formatValue={formatValue} />
        ) : (
          <ComposedChart
            data={data}
            responsive
            style={{ width: '100%', height: CHART_HEIGHT }}
            margin={showEndLabels ? MARGIN_END_LABELS : MARGIN}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="t"
              type="number"
              domain={[xMin, xMax]}
              ticks={timeTicks(xMin, xMax)}
              tickFormatter={formatShortClock}
              allowDataOverflow
              height={X_AXIS_HEIGHT}
              tick={TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
            />
            <YAxis
              domain={[scale.min, scale.max]}
              ticks={scale.ticks}
              tickFormatter={formatTick}
              width={props.yAxisWidth ?? 40}
              tick={TICK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              isAnimationActive={false}
              content={(tooltip) => (
                <ChartTooltip
                  active={tooltip.active}
                  payload={tooltip.payload}
                  label={tooltip.label}
                  series={series}
                  formatValue={formatValue}
                />
              )}
            />
            {series.map((s) => {
              const common = {
                dataKey: s.key,
                name: s.label,
                type: 'monotone' as const,
                stroke: s.color,
                strokeWidth: 2,
                dot: false,
                activeDot: { r: 4, fill: s.color, stroke: 'var(--surface)', strokeWidth: 2 },
                isAnimationActive: false,
              };
              return multiSeries ? (
                <Line
                  key={s.key}
                  {...common}
                  label={showEndLabels ? renderEndLabel(s.label, data.length - 1) : false}
                />
              ) : (
                <Area key={s.key} {...common} fill={s.color} fillOpacity={0.1} />
              );
            })}
          </ComposedChart>
        )}
      </div>
    </Panel>
  );
}
