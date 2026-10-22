// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { byteRateScale, linearTicks, niceCeil, temperatureScale, timeTicks } from './scale';

const MiB = 1024 * 1024;

describe('niceCeil', () => {
  it.each([
    [0.31, 0.5],
    [1, 1],
    [1.2, 2],
    [2.2, 2.5],
    [3, 5],
    [7, 10],
    [230, 250],
  ])('%d -> %d', (input, expected) => {
    expect(niceCeil(input)).toBe(expected);
  });
});

describe('linearTicks', () => {
  it('avoids floating point noise', () => {
    expect(linearTicks(0, 0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});

describe('byteRateScale', () => {
  it('uses round steps in a single binary unit', () => {
    const scale = byteRateScale(1.24 * MiB);
    expect(scale.unit).toBe('MiB');
    expect(scale.ticks.map((t) => t / MiB)).toEqual([0, 0.5, 1, 1.5]);
    expect(scale.max).toBe(1.5 * MiB);
  });

  it('keeps a minimum of 1 KiB/s for an idle link', () => {
    const scale = byteRateScale(0);
    expect(scale.unit).toBe('KiB');
    expect(scale.max).toBe(1024);
  });
});

describe('temperatureScale', () => {
  it('pads the data to a 10 °C grid at least 20 °C tall', () => {
    expect(temperatureScale([51.2, 53.9])).toEqual({ min: 40, max: 60, ticks: [40, 50, 60] });
  });

  it('falls back to a typical range without data', () => {
    expect(temperatureScale([]).ticks).toEqual([30, 40, 50, 60, 70, 80]);
  });
});

describe('timeTicks', () => {
  it('places ticks on whole minutes inside the window', () => {
    const min = Date.UTC(2026, 9, 2, 12, 0, 30);
    const max = min + 5 * 60_000;
    const ticks = timeTicks(min, max);
    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toBe(Date.UTC(2026, 9, 2, 12, 1, 0));
  });
});
