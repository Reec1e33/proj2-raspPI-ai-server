import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot, sseResponse } from '../test/fixtures';
import {
  ApiError,
  NetworkError,
  extractDetail,
  getProviders,
  openChatStream,
  parseRetryAfter,
  parseSnapshot,
} from './client';
import type { ChatRequest, SystemSnapshot } from './types';

const REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'Hi' }],
  provider: null,
  model: null,
  include_system_context: true,
  stream: true,
  max_tokens: null,
  temperature: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractDetail', () => {
  it('reads FastAPI string and validation details', () => {
    expect(extractDetail({ detail: 'agent unavailable' })).toBe('agent unavailable');
    expect(extractDetail({ detail: [{ msg: 'too long' }, { msg: 'bad role' }] })).toBe(
      'too long; bad role',
    );
    expect(extractDetail('<html>')).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('accepts seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12);
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    expect(parseRetryAfter('Fri, 02 Oct 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('parseSnapshot', () => {
  it('accepts a contract snapshot', () => {
    expect(parseSnapshot(JSON.stringify(makeSnapshot()))?.hostname).toBe('picloud');
  });

  it('rejects payloads that are not snapshots', () => {
    expect(parseSnapshot('{"hostname":"pi"}')).toBeNull();
    expect(parseSnapshot('nope')).toBeNull();
    expect(parseSnapshot('null')).toBeNull();
  });

  it('rejects a snapshot whose objects or arrays the UI reads are malformed', () => {
    const withoutPlatform: Partial<SystemSnapshot> = makeSnapshot();
    delete withoutPlatform.platform;
    expect(parseSnapshot(JSON.stringify(withoutPlatform))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), network: [null] }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), filesystems: {} }))).toBeNull();
  });
});

describe('openChatStream', () => {
  it('posts JSON with the API key header and returns the body', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse(['data: x\n\n'])));
    vi.stubGlobal('fetch', fetchMock);

    const body = await openChatStream(REQUEST, { apiKey: 'secret' });

    expect(body).toBeInstanceOf(ReadableStream);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chat');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('secret');
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it('turns an HTTP error into an ApiError with detail and Retry-After', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
        }),
      ),
    );
    const error: unknown = await openChatStream(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
      message: 'Rate limit exceeded',
    });
  });
});

describe('getProviders', () => {
  it('wraps a failed fetch in a NetworkError', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(getProviders()).rejects.toBeInstanceOf(NetworkError);
  });

  it('rejects a successful response that is not a provider list', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    await expect(getProviders()).rejects.toThrow('Unexpected response from /api/providers.');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<!doctype html>', { status: 200 })));
    await expect(getProviders()).rejects.toThrow('Unexpected response from /api/providers.');
  });

  it('describes a non-JSON error page by status', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
    );
    await expect(getProviders()).rejects.toThrow('Request failed with HTTP 502.');
  });
});
