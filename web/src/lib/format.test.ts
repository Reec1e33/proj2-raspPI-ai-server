// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  NO_VALUE,
  formatBytes,
  formatDuration,
  formatFrequency,
  formatMs,
  formatPercent,
  formatRate,
  formatTemperature,
} from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KiB'],
    [8_443_211_776, '7.9 GiB'],
    [-2048, '-2.0 KiB'],
  ])('%d -> %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it('carries into the next unit when rounding reaches 1024', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MiB');
  });

  it('returns a placeholder for missing values', () => {
    expect(formatBytes(null)).toBe(NO_VALUE);
    expect(formatBytes(Number.NaN)).toBe(NO_VALUE);
  });
});

describe('formatRate', () => {
  it('appends per-second', () => {
    expect(formatRate(1_258_291)).toBe('1.2 MiB/s');
    expect(formatRate(undefined)).toBe(NO_VALUE);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [42.9, '42s'],
    [725, '12m 5s'],
    [15_120, '4h 12m'],
    [86_400.5, '1d 0h'],
    [273_600, '3d 4h'],
  ])('%d s -> %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('rejects negative or missing durations', () => {
    expect(formatDuration(-1)).toBe(NO_VALUE);
    expect(formatDuration(null)).toBe(NO_VALUE);
  });
});

describe('small formatters', () => {
  it('formats percentages', () => {
    expect(formatPercent(12.34)).toBe('12.3%');
    expect(formatPercent(100, 0)).toBe('100%');
    expect(formatPercent(null)).toBe(NO_VALUE);
  });

  it('formats temperatures', () => {
    expect(formatTemperature(51.24)).toBe('51.2 °C');
    expect(formatTemperature(null)).toBe(NO_VALUE);
  });

  it('formats CPU frequencies', () => {
    expect(formatFrequency(2400)).toBe('2.4 GHz');
    expect(formatFrequency(600)).toBe('600 MHz');
    expect(formatFrequency(null)).toBe(NO_VALUE);
  });

  it('formats latencies', () => {
    expect(formatMs(229.6)).toBe('230 ms');
    expect(formatMs(1240)).toBe('1.24 s');
  });
});
