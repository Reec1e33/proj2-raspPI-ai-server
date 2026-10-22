// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('returns items oldest first while below capacity', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.toArray()).toEqual([1, 2]);
    expect(buffer.size).toBe(2);
    expect(buffer.last()).toBe(2);
  });

  it('overwrites the oldest items once full', () => {
    const buffer = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) buffer.push(i);
    expect(buffer.toArray()).toEqual([5, 6, 7]);
    expect(buffer.size).toBe(3);
    expect(buffer.last()).toBe(7);
  });

  it('is empty after clear', () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push('a');
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.last()).toBeUndefined();
    buffer.push('b');
    expect(buffer.toArray()).toEqual(['b']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});
