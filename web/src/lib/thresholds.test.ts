// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ThrottlingStatus } from '../api/types';
import { backoffDelay } from './backoff';
import { DISK_THRESHOLDS, TEMPERATURE_THRESHOLDS, levelFor } from './thresholds';
import { summarizeThrottling } from './throttling';

describe('levelFor', () => {
  it.each([
    [59.9, 'good'],
    [60, 'warning'],
    [74.9, 'warning'],
    [75, 'critical'],
    [null, 'unknown'],
  ] as const)('%s °C -> %s', (value, level) => {
    expect(levelFor(value, TEMPERATURE_THRESHOLDS)).toBe(level);
  });

  it('flags a disk at the alert threshold as critical', () => {
    expect(levelFor(85, DISK_THRESHOLDS)).toBe('critical');
  });
});

const NO_FLAGS: ThrottlingStatus = {
  supported: true,
  raw: '0x0',
  under_voltage_now: false,
  frequency_capped_now: false,
  throttled_now: false,
  soft_temp_limit_now: false,
  under_voltage_occurred: false,
  frequency_capped_occurred: false,
  throttled_occurred: false,
  soft_temp_limit_occurred: false,
};

describe('summarizeThrottling', () => {
  it('reports no events', () => {
    expect(summarizeThrottling(NO_FLAGS).level).toBe('good');
  });

  it('ranks an active condition above past ones', () => {
    const summary = summarizeThrottling({
      ...NO_FLAGS,
      raw: '0x50005',
      under_voltage_now: true,
      throttled_now: true,
      under_voltage_occurred: true,
    });
    expect(summary).toMatchObject({ level: 'critical', value: 'Under-voltage, Throttled' });
  });

  it('warns about conditions that occurred since boot', () => {
    const summary = summarizeThrottling({ ...NO_FLAGS, soft_temp_limit_occurred: true });
    expect(summary).toMatchObject({ level: 'warning', detail: 'Soft temp limit' });
  });

  it('reports unsupported hosts as unknown', () => {
    expect(summarizeThrottling({ ...NO_FLAGS, supported: false, raw: null }).level).toBe('unknown');
  });
});

describe('backoffDelay', () => {
  it('doubles per attempt within [d/2, d) and caps at the maximum', () => {
    const low = () => 0;
    const high = () => 0.999;
    expect(backoffDelay(0, { random: low })).toBe(500);
    expect(backoffDelay(0, { random: high })).toBe(1000);
    expect(backoffDelay(3, { random: low })).toBe(4000);
    expect(backoffDelay(20, { random: low })).toBe(15_000);
    expect(backoffDelay(20, { random: high })).toBeLessThanOrEqual(30_000);
  });
});
