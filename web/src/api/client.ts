import type { ChatRequest, ProviderInfo, SystemSnapshot } from './types';

/** The API answered with a non-2xx status. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  /** Parsed `Retry-After` header (429), in seconds. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never got an HTTP response (API or gateway unreachable). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

/** Works across realms (jsdom vs. Node fetch), unlike `instanceof DOMException`. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

/** Pulls a human-readable message out of a FastAPI-style error body. */
export function extractDetail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { detail, message } = body as { detail?: unknown; message?: unknown };
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // 422 validation errors: [{ loc, msg, type }, ...]
    const messages = detail.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'msg' in item && typeof item.msg === 'string'
        ? [item.msg]
        : [],
    );
    if (messages.length > 0) return messages.join('; ');
  }
  return typeof message === 'string' ? message : null;
}

/** Parses a `Retry-After` header given as delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

interface RequestOptions extends RequestInit {
  apiKey?: string;
}

async function request(path: string, { apiKey, ...init }: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set('X-API-Key', apiKey);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new NetworkError('Cannot reach the PiCloud API.', { cause: error });
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function toApiError(response: Response): Promise<ApiError> {
  let detail: string | null = null;
  try {
    detail = extractDetail(await response.json());
  } catch {
    // Body was empty or not JSON (e.g. an nginx error page).
  }
  return new ApiError(
    detail ?? `Request failed with HTTP ${response.status}.`,
    response.status,
    parseRetryAfter(response.headers.get('Retry-After')),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRecord);
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await request(path, { headers: { Accept: 'application/json' }, signal });
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (isAbortError(error)) throw error;
    // For example an HTML page from a misrouted proxy.
    throw new Error(`Unexpected response from ${path}.`, { cause: error });
  }
}

export async function getProviders(signal?: AbortSignal): Promise<ProviderInfo[]> {
  const providers = await getJson('/api/providers', signal);
  if (!isRecordArray(providers)) {
    throw new Error('Unexpected response from /api/providers.');
  }
  return providers as ProviderInfo[];
}

/** Starts a streaming chat request and returns the raw `text/event-stream` body. */
export async function openChatStream(
  body: ChatRequest,
  options: { signal?: AbortSignal; apiKey?: string } = {},
): Promise<ReadableStream<Uint8Array>> {
  const response = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: options.signal,
    apiKey: options.apiKey,
  });
  if (!response.body) throw new ApiError('The chat response had no body.', response.status);
  return response.body;
}

/**
 * Parses the data of a `snapshot` SSE event. Returns null for malformed
 * payloads so one bad frame cannot take the dashboard down. The API already
 * validates snapshots against the agent contract (pydantic), so this checks
 * only the objects and arrays that the UI dereferences, not every number.
 */
export function parseSnapshot(data: string): SystemSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { hostname, collected_at, platform, cpu, memory, filesystems, network, throttling } = value;
  const valid =
    typeof hostname === 'string' &&
    typeof collected_at === 'string' &&
    isRecord(platform) &&
    isRecord(cpu) &&
    Array.isArray(cpu.per_core_percent) &&
    isRecord(cpu.load_average) &&
    isRecord(memory) &&
    isRecordArray(filesystems) &&
    isRecordArray(network) &&
    isRecord(throttling);
  return valid ? (value as unknown as SystemSnapshot) : null;
}

/** A short, user-facing description of any error thrown by this module. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'The API key is missing or wrong. Set it in Settings.';
    // The api never sends 401: only the gateway's basic auth does.
    if (error.status === 401)
      return 'The gateway asked for the site password again. Reload the page.';
    if (error.status === 429) {
      return error.retryAfterSeconds === null
        ? 'Too many requests. Try again soon.'
        : `Too many requests. Try again in ${error.retryAfterSeconds} s.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
}
