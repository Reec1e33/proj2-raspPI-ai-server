import { useEffect, useState } from 'react';
import { parseSnapshot } from '../api/client';
import type { SystemSnapshot, SystemStreamError } from '../api/types';
import { backoffDelay } from '../lib/backoff';
import { type Sample, SampleHistory, toSample } from '../lib/samples';

/** How much history the live charts keep. */
export const HISTORY_WINDOW_MS = 5 * 60_000;
/** Upper bound on stored samples; enough for one sample per second over the window. */
const HISTORY_CAPACITY = 300;

/**
 * `stale`: snapshot events still arrive, but the agent's reading stopped
 * advancing (`collected_at` is frozen), for example a sampler stuck on a dead
 * mount while the API keeps serving its last cached snapshot.
 */
export type ConnectionStatus = 'connecting' | 'live' | 'stale' | 'offline';

export interface SystemStreamState {
  status: ConnectionStatus;
  /** Latest snapshot. It is kept while offline so panels can show stale data. */
  snapshot: SystemSnapshot | null;
  /** Samples inside HISTORY_WINDOW_MS, oldest first, with gap markers. */
  history: Sample[];
  /** Why the stream is offline or stale, or null while connecting/live. */
  error: string | null;
}

const INITIAL_STATE: SystemStreamState = {
  status: 'connecting',
  snapshot: null,
  history: [],
  error: null,
};

function parseStreamError(data: string): string {
  try {
    const { detail } = JSON.parse(data) as Partial<SystemStreamError>;
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    // fall through
  }
  return 'agent unavailable';
}

/**
 * Once events flow, silence longer than this (or four times the largest gap
 * seen between events, if that is longer) means the connection is dead even
 * though the socket looks open. Scaling with the observed gap keeps a long
 * PICLOUD_STREAM_INTERVAL_S from tripping the watchdog.
 */
export const STALE_AFTER_MS = 10_000;
/** Allowance for the first two events, before the stream interval is known. */
export const FIRST_EVENTS_TIMEOUT_MS = 60_000;

/**
 * The reading is stale when `collected_at` has not changed for this long while
 * events keep arriving, or for three agent sampling intervals if that is
 * longer. Both sides of the comparison are browser receive times, so clock
 * skew between the browser and the Pi does not matter.
 */
export const FROZEN_AFTER_MS = 15_000;
/** Allowance while only one reading has been seen (sampling interval unknown). */
export const FIRST_ADVANCE_TIMEOUT_MS = 30_000;

/**
 * Subscribes to `/api/system/stream` with EventSource.
 *
 * EventSource retries transient drops by itself but gives up for good on an
 * HTTP error (for example a 502 from the gateway while the API restarts), and
 * it never notices a connection that stalls without closing (a proxy that
 * keeps the client side open, a half-open TCP socket after sleep). So the hook
 * owns reconnection: a connection error or a silent stream (see STALE_AFTER_MS)
 * closes the source and reconnects with exponential backoff and jitter. The backoff
 * resets on the first snapshot of the new connection.
 */
export function useSystemStream(url = '/api/system/stream'): SystemStreamState {
  const [state, setState] = useState<SystemStreamState>(INITIAL_STATE);

  useEffect(() => {
    const samples = new SampleHistory(HISTORY_CAPACITY);
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastEventAt = 0;
    let maxGapMs = 0;
    // Staleness tracking spans reconnects: a frozen agent stays frozen.
    let lastCollectedAt: string | null = null;
    let lastAdvanceAt = 0;
    let minAdvanceMs = Number.POSITIVE_INFINITY;

    const reconnect = (reason: string) => {
      clearTimeout(staleTimer);
      source?.close();
      source = null;
      const delay = backoffDelay(attempt++);
      setState((prev) => ({ ...prev, status: 'offline', error: reason }));
      retryTimer = setTimeout(() => {
        setState((prev) => ({ ...prev, status: 'connecting' }));
        connect();
      }, delay);
    };

    const armWatchdog = (timeoutMs: number) => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        reconnect('No data from the API.');
      }, timeoutMs);
    };

    // Every server event proves the connection is alive; re-arm the watchdog.
    const markAlive = () => {
      const now = Date.now();
      if (lastEventAt > 0) maxGapMs = Math.max(maxGapMs, now - lastEventAt);
      lastEventAt = now;
      armWatchdog(maxGapMs > 0 ? Math.max(STALE_AFTER_MS, 4 * maxGapMs) : FIRST_EVENTS_TIMEOUT_MS);
    };

    const onSnapshot = (event: MessageEvent<string>) => {
      markAlive();
      const snapshot = parseSnapshot(event.data);
      if (!snapshot) return;
      attempt = 0;
      samples.add(toSample(snapshot));
      const now = Date.now();
      if (snapshot.collected_at !== lastCollectedAt) {
        if (lastAdvanceAt > 0) minAdvanceMs = Math.min(minAdvanceMs, now - lastAdvanceAt);
        lastCollectedAt = snapshot.collected_at;
        lastAdvanceAt = now;
      }
      const frozenAfterMs = Number.isFinite(minAdvanceMs)
        ? Math.max(FROZEN_AFTER_MS, 3 * minAdvanceMs)
        : FIRST_ADVANCE_TIMEOUT_MS;
      const frozen = now - lastAdvanceAt > frozenAfterMs;
      setState({
        status: frozen ? 'stale' : 'live',
        snapshot,
        history: samples.window(HISTORY_WINDOW_MS),
        error: frozen ? 'The agent sent no new reading.' : null,
      });
    };

    const onError = (event: Event) => {
      if (event instanceof MessageEvent) {
        // `event: error` sent by the API: the agent is down, the stream stays open.
        markAlive();
        const detail = parseStreamError(String(event.data));
        setState((prev) => ({ ...prev, status: 'offline', error: `Agent: ${detail}` }));
        return;
      }
      reconnect('Lost connection to the API.');
    };

    function connect() {
      lastEventAt = 0;
      maxGapMs = 0;
      source = new EventSource(url);
      source.addEventListener('snapshot', onSnapshot);
      source.addEventListener('error', onError);
      armWatchdog(FIRST_EVENTS_TIMEOUT_MS);
    }

    connect();
    return () => {
      clearTimeout(retryTimer);
      clearTimeout(staleTimer);
      source?.close();
    };
  }, [url]);

  return state;
}
