/** Shown wherever a value is unknown or unsupported. */
export const NO_VALUE = '—';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Binary (IEC) byte size, e.g. 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (!isNumber(bytes)) return NO_VALUE;
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit++;
  }
  let digits = unit === 0 ? 0 : fractionDigits;
  // Rounding can carry into the next unit (1023.97 KiB -> "1024.0 KiB").
  if (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(digits)) >= 1024) {
    value /= 1024;
    unit++;
    digits = fractionDigits;
  }
  return `${sign}${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Byte rate, e.g. 1536 -> "1.5 KiB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  return isNumber(bytesPerSecond) ? `${formatBytes(bytesPerSecond)}/s` : NO_VALUE;
}

/** Compact duration with the two most significant units, e.g. "3d 4h", "12m 5s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNumber(seconds) || seconds < 0) return NO_VALUE;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Percentage, e.g. 12.34 -> "12.3%". */
export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  return isNumber(value) ? `${value.toFixed(fractionDigits)}%` : NO_VALUE;
}

export function formatTemperature(celsius: number | null | undefined): string {
  return isNumber(celsius) ? `${celsius.toFixed(1)} °C` : NO_VALUE;
}

/** CPU clock, e.g. 2400 -> "2.4 GHz", 600 -> "600 MHz". */
export function formatFrequency(mhz: number | null | undefined): string {
  if (!isNumber(mhz)) return NO_VALUE;
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${Math.round(mhz)} MHz`;
}

/** Latency, e.g. 230 -> "230 ms", 1240 -> "1.24 s". */
export function formatMs(ms: number | null | undefined): string {
  if (!isNumber(ms)) return NO_VALUE;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const shortClockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Local wall-clock time of an epoch-ms timestamp, e.g. "14:05:09". */
export function formatClock(epochMs: number): string {
  return clockFormat.format(epochMs);
}

/** Local wall-clock time without seconds, for axis ticks, e.g. "14:05". */
export function formatShortClock(epochMs: number): string {
  return shortClockFormat.format(epochMs);
}
