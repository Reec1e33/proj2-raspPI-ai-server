import type { ProviderInfo, SystemSnapshot } from '../api/types';

/** A realistic Pi 5 snapshot matching the agent contract. */
export function makeSnapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    hostname: 'picloud',
    collected_at: '2026-10-02T12:00:00Z',
    uptime_seconds: 86_400.5,
    platform: {
      model: 'Raspberry Pi 5 Model B Rev 1.0',
      os: 'Debian GNU/Linux 12 (bookworm)',
      kernel: '6.6.51+rpt-rpi-2712',
      arch: 'arm64',
    },
    cpu: {
      cores: 4,
      usage_percent: 12.3,
      per_core_percent: [10.1, 14.0, 9.8, 15.2],
      load_average: { one: 0.42, five: 0.35, fifteen: 0.3 },
      temperature_celsius: 51.2,
      frequency_mhz: 2400,
    },
    memory: {
      total_bytes: 8_443_211_776,
      available_bytes: 6_000_000_000,
      used_bytes: 2_443_211_776,
      usage_percent: 28.9,
      swap_total_bytes: 536_866_816,
      swap_used_bytes: 0,
    },
    filesystems: [
      {
        mountpoint: '/',
        total_bytes: 62_000_000_000,
        used_bytes: 21_000_000_000,
        available_bytes: 38_000_000_000,
        usage_percent: 35.6,
      },
    ],
    network: [
      {
        interface: 'eth0',
        rx_bytes_total: 1_000_000,
        tx_bytes_total: 500_000,
        rx_bytes_per_second: 125_000,
        tx_bytes_per_second: 42_000,
      },
    ],
    throttling: {
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
    },
    ...overrides,
  };
}

export const PROVIDERS: ProviderInfo[] = [
  { name: 'ollama', enabled: true, local: true, model: 'llama3.2:1b', circuit: 'closed' },
  { name: 'anthropic', enabled: true, local: false, model: 'claude-haiku-4-5', circuit: 'open' },
  { name: 'openai', enabled: false, local: false, model: 'gpt-4o-mini', circuit: 'closed' },
];

const encoder = new TextEncoder();

/**
 * A fetch Response whose body streams `chunks` as text/event-stream. With
 * `keepOpen`, the body stays open until the request's AbortSignal fires, like
 * a real streaming fetch.
 */
export function sseResponse(
  chunks: string[],
  { keepOpen = false, signal }: { keepOpen?: boolean; signal?: AbortSignal | null } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) {
        controller.close();
        return;
      }
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
