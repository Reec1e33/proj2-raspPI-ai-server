import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../test/fixtures';
import { MockEventSource } from '../test/mockEventSource';
import {
  FIRST_ADVANCE_TIMEOUT_MS,
  FIRST_EVENTS_TIMEOUT_MS,
  FROZEN_AFTER_MS,
  STALE_AFTER_MS,
  useSystemStream,
} from './useSystemStream';

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.spyOn(Math, 'random').mockReturnValue(0); // first retry after 500 ms
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSystemStream', () => {
  it('goes live on the first snapshot and records history once per sample', () => {
    const { result } = renderHook(() => useSystemStream());
    expect(result.current.status).toBe('connecting');
    expect(MockEventSource.latest().url).toBe('/api/system/stream');

    const snapshot = makeSnapshot();
    act(() => {
      MockEventSource.latest().emit('snapshot', snapshot);
      MockEventSource.latest().emit('snapshot', snapshot); // same collected_at
      MockEventSource.latest().emit('snapshot', 'not json');
    });

    expect(result.current.status).toBe('live');
    expect(result.current.snapshot?.hostname).toBe('picloud');
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]).toMatchObject({ cpuPercent: 12.3, temperatureC: 51.2 });
  });

  it('shows an agent error from the API without dropping the connection', () => {
    const { result } = renderHook(() => useSystemStream());
    act(() => MockEventSource.latest().emit('error', { detail: 'agent unavailable' }));

    expect(result.current.status).toBe('offline');
    expect(result.current.error).toBe('Agent: agent unavailable');
    expect(MockEventSource.latest().closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('reconnects with backoff after a connection error and keeps the last snapshot', () => {
    const { result } = renderHook(() => useSystemStream());
    act(() => MockEventSource.latest().emit('snapshot', makeSnapshot()));
    const first = MockEventSource.latest();

    act(() => first.fail());
    expect(result.current.status).toBe('offline');
    expect(result.current.snapshot).not.toBeNull();
    expect(first.closed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    expect(result.current.status).toBe('connecting');

    act(() =>
      MockEventSource.latest().emit(
        'snapshot',
        makeSnapshot({ collected_at: '2026-10-02T12:00:02Z' }),
      ),
    );
    expect(result.current.status).toBe('live');
    expect(result.current.history).toHaveLength(2);
  });

  it('backs off longer after repeated failures', () => {
    renderHook(() => useSystemStream());
    act(() => MockEventSource.latest().fail()); // retry in 500 ms
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => MockEventSource.latest().fail()); // retry in 1000 ms
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances).toHaveLength(3);
  });

  const snapshotAt = (second: number) =>
    makeSnapshot({ collected_at: new Date(Date.UTC(2026, 9, 2, 12, 0, second)).toISOString() });

  it('reconnects when a stream that looks open goes silent', () => {
    const { result } = renderHook(() => useSystemStream());
    const first = MockEventSource.latest();
    act(() => {
      first.emit('snapshot', snapshotAt(0));
      vi.advanceTimersByTime(2_000);
      first.emit('snapshot', snapshotAt(2));
    });

    act(() => {
      vi.advanceTimersByTime(STALE_AFTER_MS - 1);
    });
    expect(result.current.status).toBe('live');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.status).toBe('offline');
    expect(result.current.error).toBe('No data from the API.');
    expect(first.closed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('gives up on a connection that never sends an event', () => {
    const { result } = renderHook(() => useSystemStream());
    act(() => {
      vi.advanceTimersByTime(FIRST_EVENTS_TIMEOUT_MS);
    });
    expect(result.current.status).toBe('offline');
    expect(MockEventSource.latest().closed).toBe(true);
  });

  it('keeps a stream with a long interval alive', () => {
    const { result } = renderHook(() => useSystemStream());
    const source = MockEventSource.latest();
    // e.g. PICLOUD_STREAM_INTERVAL_S=30, far above STALE_AFTER_MS.
    for (let i = 0; i < 5; i++) {
      act(() => {
        source.emit('snapshot', snapshotAt(i * 30));
        vi.advanceTimersByTime(30_000);
      });
    }
    expect(result.current.status).toBe('live');
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('breaks the chart line where readings are missing', () => {
    const { result } = renderHook(() => useSystemStream());
    const source = MockEventSource.latest();
    act(() => {
      for (const second of [0, 2, 4, 64]) source.emit('snapshot', snapshotAt(second));
    });

    const history = result.current.history;
    expect(history.map((s) => s.t - Date.UTC(2026, 9, 2, 12))).toEqual([
      0, 2_000, 4_000, 34_000, 64_000,
    ]);
    expect(history[3]).toMatchObject({
      cpuPercent: null,
      memoryPercent: null,
      rxBytesPerSecond: null,
    });
    expect(history[4]?.cpuPercent).toBe(12.3);
  });

  it('restarts the history when the host clock steps back', () => {
    const { result } = renderHook(() => useSystemStream());
    const source = MockEventSource.latest();
    act(() => {
      for (const second of [10, 12, 4]) source.emit('snapshot', snapshotAt(second));
    });
    expect(result.current.history).toHaveLength(1);
  });

  it('marks the reading stale when collected_at stops advancing on a healthy stream', () => {
    const { result } = renderHook(() => useSystemStream());
    const source = MockEventSource.latest();
    // The agent samples every 2 s, then freezes at second 4; the API keeps resending it.
    act(() => {
      for (const second of [0, 2, 4]) {
        source.emit('snapshot', snapshotAt(second));
        vi.advanceTimersByTime(2_000);
      }
    });
    for (let elapsed = 2_000; elapsed <= FROZEN_AFTER_MS; elapsed += 2_000) {
      act(() => {
        source.emit('snapshot', snapshotAt(4));
        vi.advanceTimersByTime(2_000);
      });
    }
    expect(result.current.status).toBe('live');

    act(() => source.emit('snapshot', snapshotAt(4)));
    expect(result.current.status).toBe('stale');
    expect(result.current.error).toBe('The agent sent no new reading.');
    expect(source.closed).toBe(false); // the connection itself is healthy

    act(() => source.emit('snapshot', snapshotAt(22)));
    expect(result.current.status).toBe('live');
    expect(result.current.error).toBeNull();
  });

  it('allows a longer wait for staleness before the sampling interval is known', () => {
    const { result } = renderHook(() => useSystemStream());
    const source = MockEventSource.latest();
    act(() => {
      source.emit('snapshot', snapshotAt(0));
      vi.advanceTimersByTime(FROZEN_AFTER_MS + 1);
      source.emit('snapshot', snapshotAt(0));
    });
    expect(result.current.status).toBe('live');
    act(() => {
      vi.advanceTimersByTime(FIRST_ADVANCE_TIMEOUT_MS - FROZEN_AFTER_MS);
      source.emit('snapshot', snapshotAt(0));
    });
    expect(result.current.status).toBe('stale');
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useSystemStream());
    unmount();
    expect(MockEventSource.latest().closed).toBe(true);
  });
});
