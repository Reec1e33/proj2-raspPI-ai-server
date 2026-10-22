/** Axis domain plus the tick values to draw on it. */
export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** Evenly spaced ticks from `min` to `max` inclusive, free of float noise. */
export function linearTicks(min: number, max: number, step: number): number[] {
  const count = Math.round((max - min) / step);
  return Array.from({ length: count + 1 }, (_, i) => Number((min + i * step).toPrecision(12)));
}

/** Smallest "nice" number (1, 2, 2.5 or 5 x 10^k) that is >= `value`. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = [1, 2, 2.5, 5].find((n) => fraction <= n + 1e-9) ?? 10;
  return Number((nice * magnitude).toPrecision(12));
}

export const PERCENT_SCALE: Scale = { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** A byte-rate scale whose ticks are all expressed in one binary unit. */
export interface ByteScale extends Scale {
  unit: (typeof BYTE_UNITS)[number];
  unitBytes: number;
}

/**
 * Zero-based scale for byte rates with round ticks in a single unit
 * (0, 0.5, 1, 1.5 MiB/s rather than 0, 512 KiB, 1 MiB, ...).
 */
export function byteRateScale(maxValue: number, targetTicks = 4): ByteScale {
  const peak = Math.max(maxValue, 1024); // keep an idle link's axis at >= 1 KiB/s
  let index = 0;
  while (index < BYTE_UNITS.length - 1 && peak / 1024 ** index >= 1024) index++;
  const unitBytes = 1024 ** index;
  const step = niceCeil(peak / unitBytes / targetTicks);
  const top = step * Math.ceil(peak / unitBytes / step);
  return {
    min: 0,
    max: top * unitBytes,
    ticks: linearTicks(0, top, step).map((tick) => tick * unitBytes),
    unit: BYTE_UNITS[index] ?? 'B',
    unitBytes,
  };
}

/** Wall-clock ticks every `stepMs`, aligned to whole steps (whole minutes by default). */
export function timeTicks(min: number, max: number, stepMs = 60_000): number[] {
  const ticks: number[] = [];
  for (let t = Math.ceil(min / stepMs) * stepMs; t <= max; t += stepMs) ticks.push(t);
  return ticks;
}

/** Temperature scale on a 10 °C grid around the data, at least 20 °C tall. */
export function temperatureScale(values: readonly number[]): Scale {
  if (values.length === 0) return { min: 30, max: 80, ticks: linearTicks(30, 80, 10) };
  const min = Math.floor((Math.min(...values) - 2) / 10) * 10;
  const max = Math.max(Math.ceil((Math.max(...values) + 2) / 10) * 10, min + 20);
  return { min, max, ticks: linearTicks(min, max, 10) };
}
