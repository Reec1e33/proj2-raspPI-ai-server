import type { FilesystemStats, NetworkInterfaceStats, SystemSnapshot } from '../api/types';
import { RingBuffer } from './ringBuffer';

/**
 * The numbers the live charts plot, taken from one snapshot. A sample whose
 * values are all null marks a gap: the charts break the line there instead
 * of drawing a straight segment across missing data.
 */
export interface Sample {
  /** Epoch milliseconds of `collected_at`. */
  t: number;
  cpuPercent: number | null;
  temperatureC: number | null;
  memoryPercent: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

function gapSample(t: number): Sample {
  return {
    t,
    cpuPercent: null,
    temperatureC: null,
    memoryPercent: null,
    rxBytesPerSecond: null,
    txBytesPerSecond: null,
  };
}

/** A jump of more than this many sampling intervals between readings is a gap. */
const GAP_INTERVALS = 3;
/** Never call a jump shorter than this a gap (the API can skip one agent sample). */
const MIN_GAP_MS = 10_000;

/**
 * Chart history: one sample per agent reading, oldest first, with gap markers
 * where readings are missing (API or agent down, stream reconnecting).
 */
export class SampleHistory {
  readonly #buffer: RingBuffer<Sample>;
  /** Smallest interval seen between two readings: the agent's sampling period. */
  #intervalMs = Number.POSITIVE_INFINITY;

  constructor(capacity: number) {
    this.#buffer = new RingBuffer<Sample>(capacity);
  }

  add(sample: Sample): void {
    const last = this.#buffer.last();
    if (last?.t === sample.t) return; // the API may resend the agent's cached reading
    if (last && sample.t < last.t) {
      // The host clock stepped back; restart rather than plot points out of order.
      this.#buffer.clear();
      this.#intervalMs = Number.POSITIVE_INFINITY;
    } else if (last) {
      const elapsed = sample.t - last.t;
      if (elapsed > Math.max(MIN_GAP_MS, GAP_INTERVALS * this.#intervalMs)) {
        this.#buffer.push(gapSample((last.t + sample.t) / 2));
      }
      this.#intervalMs = Math.min(this.#intervalMs, elapsed);
    }
    this.#buffer.push(sample);
  }

  /** Samples no older than `windowMs` before the newest one. */
  window(windowMs: number): Sample[] {
    return trimToWindow(this.#buffer.toArray(), windowMs);
  }
}

export function networkTotals(network: readonly NetworkInterfaceStats[]): {
  rx: number;
  tx: number;
} {
  return network.reduce(
    (sum, nic) => ({
      rx: sum.rx + nic.rx_bytes_per_second,
      tx: sum.tx + nic.tx_bytes_per_second,
    }),
    { rx: 0, tx: 0 },
  );
}

/** The "/" filesystem, or the first one reported when "/" is not monitored. */
export function rootFilesystem(
  filesystems: readonly FilesystemStats[],
): FilesystemStats | undefined {
  return filesystems.find((fs) => fs.mountpoint === '/') ?? filesystems[0];
}

export function toSample(snapshot: SystemSnapshot, now = Date.now()): Sample {
  const collectedAt = Date.parse(snapshot.collected_at);
  const { rx, tx } = networkTotals(snapshot.network);
  return {
    t: Number.isNaN(collectedAt) ? now : collectedAt,
    cpuPercent: snapshot.cpu.usage_percent,
    temperatureC: snapshot.cpu.temperature_celsius,
    memoryPercent: snapshot.memory.usage_percent,
    rxBytesPerSecond: rx,
    txBytesPerSecond: tx,
  };
}

/** Samples no older than `windowMs` before the newest one (input sorted oldest first). */
function trimToWindow(samples: readonly Sample[], windowMs: number): Sample[] {
  const newest = samples.at(-1);
  if (!newest) return [];
  const cutoff = newest.t - windowMs;
  return samples.filter((s) => s.t >= cutoff);
}
