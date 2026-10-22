/**
 * Wire types for the PiCloud API. These mirror the integration contract
 * exactly (snake_case keys, nullable fields as `| null`).
 */

// --- System snapshot (GET /api/system, `snapshot` events on /api/system/stream)

export interface Platform {
  model: string | null;
  os: string | null;
  kernel: string | null;
  arch: string;
}

export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

export interface CpuStats {
  cores: number;
  usage_percent: number;
  per_core_percent: number[];
  load_average: LoadAverage;
  temperature_celsius: number | null;
  frequency_mhz: number | null;
}

export interface MemoryStats {
  total_bytes: number;
  available_bytes: number;
  used_bytes: number;
  usage_percent: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
}

export interface FilesystemStats {
  mountpoint: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  usage_percent: number;
}

export interface NetworkInterfaceStats {
  interface: string;
  rx_bytes_total: number;
  tx_bytes_total: number;
  rx_bytes_per_second: number;
  tx_bytes_per_second: number;
}

export interface ThrottlingStatus {
  supported: boolean;
  raw: string | null;
  under_voltage_now: boolean;
  frequency_capped_now: boolean;
  throttled_now: boolean;
  soft_temp_limit_now: boolean;
  under_voltage_occurred: boolean;
  frequency_capped_occurred: boolean;
  throttled_occurred: boolean;
  soft_temp_limit_occurred: boolean;
}

export interface SystemSnapshot {
  hostname: string;
  /** RFC 3339 timestamp. */
  collected_at: string;
  uptime_seconds: number;
  platform: Platform;
  cpu: CpuStats;
  memory: MemoryStats;
  filesystems: FilesystemStats[];
  network: NetworkInterfaceStats[];
  throttling: ThrottlingStatus;
}

/** Data of an `error` event on /api/system/stream (agent unreachable). */
export interface SystemStreamError {
  detail: string;
}

// --- Health (GET /api/health, GET /api/ready)

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime_seconds: number;
}

export interface ReadyResponse {
  status: 'ready' | 'degraded';
  checks: {
    agent: string;
    providers: string;
  };
}

// --- Providers (GET /api/providers)

export type ProviderName = 'ollama' | 'anthropic' | 'openai';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface ProviderInfo {
  name: ProviderName;
  enabled: boolean;
  local: boolean;
  model: string;
  circuit: CircuitState;
}

// --- Chat (POST /api/chat)

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  provider: ProviderName | null;
  model: string | null;
  include_system_context: boolean;
  stream: boolean;
  max_tokens: number | null;
  temperature: number | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ProviderFallback {
  provider: ProviderName;
  reason: string;
}

/** `event: meta` — sent first, and again if a fallback switches provider before the first token. */
export interface ChatMetaEvent {
  request_id: string;
  provider: ProviderName;
  model: string;
}

/** `event: token` */
export interface ChatTokenEvent {
  text: string;
}

/** `event: done` */
export interface ChatDoneEvent {
  provider: ProviderName;
  model: string;
  usage: TokenUsage;
  latency_ms: number;
  /** null when the provider finished without sending any text. */
  ttft_ms: number | null;
  fallbacks: ProviderFallback[];
}

export type ChatErrorCode =
  'all_providers_failed' | 'provider_error' | 'rate_limited' | 'unauthorized';

/** `event: error` */
export interface ChatErrorEvent {
  code: ChatErrorCode;
  message: string;
}

/** Response body when the request sets `"stream": false`. */
export interface ChatResponse {
  provider: ProviderName;
  model: string;
  content: string;
  usage: TokenUsage;
  latency_ms: number;
  fallbacks: ProviderFallback[];
}
