import type { ThrottlingStatus } from '../api/types';
import { NO_VALUE } from './format';
import type { Level } from './thresholds';

/** The four firmware conditions (get_throttled bits 0-3 and 16-19). */
export const THROTTLE_CONDITIONS = [
  { label: 'Under-voltage', now: 'under_voltage_now', occurred: 'under_voltage_occurred' },
  {
    label: 'Frequency capped',
    now: 'frequency_capped_now',
    occurred: 'frequency_capped_occurred',
  },
  { label: 'Throttled', now: 'throttled_now', occurred: 'throttled_occurred' },
  { label: 'Soft temp limit', now: 'soft_temp_limit_now', occurred: 'soft_temp_limit_occurred' },
] as const satisfies readonly {
  label: string;
  now: keyof ThrottlingStatus;
  occurred: keyof ThrottlingStatus;
}[];

export interface ThrottleSummary {
  level: Level;
  levelLabel: string;
  value: string;
  detail: string;
}

/** One-line summary of the eight flags; an active condition outranks a past one. */
export function summarizeThrottling(status: ThrottlingStatus): ThrottleSummary {
  if (!status.supported) {
    return {
      level: 'unknown',
      levelLabel: 'Unsupported',
      value: NO_VALUE,
      detail: 'No firmware throttle flags',
    };
  }
  const active = THROTTLE_CONDITIONS.filter((c) => status[c.now]).map((c) => c.label);
  const past = THROTTLE_CONDITIONS.filter((c) => status[c.occurred]).map((c) => c.label);

  if (active.length > 0) {
    return {
      level: 'critical',
      levelLabel: 'Active',
      value: active.join(', '),
      detail: 'Check power and cooling',
    };
  }
  if (past.length > 0) {
    return {
      level: 'warning',
      levelLabel: 'Since boot',
      value: 'OK now',
      detail: past.join(', '),
    };
  }
  return { level: 'good', levelLabel: 'OK', value: 'None', detail: 'No events since boot' };
}
