/** Severity of a reading. `unknown` covers missing or unsupported sources. */
export type Level = 'good' | 'warning' | 'critical' | 'unknown';

export interface Thresholds {
  /** Readings at or above this value are `warning`. */
  warning: number;
  /** Readings at or above this value are `critical`. */
  critical: number;
}

/** CPU temperature in °C. The Pi firmware starts soft throttling near 80 °C. */
export const TEMPERATURE_THRESHOLDS: Thresholds = { warning: 60, critical: 75 };

/** CPU and memory usage in percent. Critical memory matches the <10 % available alert. */
export const USAGE_THRESHOLDS: Thresholds = { warning: 75, critical: 90 };

/** Filesystem usage in percent. Critical matches the PiDiskAlmostFull alert (>85 %). */
export const DISK_THRESHOLDS: Thresholds = { warning: 75, critical: 85 };

export function levelFor(value: number | null | undefined, thresholds: Thresholds): Level {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if (value >= thresholds.critical) return 'critical';
  if (value >= thresholds.warning) return 'warning';
  return 'good';
}
