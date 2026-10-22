# ADR-0007: Use Server-Sent Events for live telemetry and chat

- Status: Accepted
- Date: 2026-10-02

## Context

The dashboard shows a new host sample every 2 seconds. The chat shows the
answer token by token. Both go through the nginx gateway with TLS, HTTP/2 and
basic auth.

These are the options:

1. Periodic requests with `fetch`. They are simple, but each update is a full
   request, and the chat cannot show tokens as they arrive.
2. WebSockets. They are two-way, but they need an upgrade through nginx, their
   own reconnection logic and their own message format.
3. Server-Sent Events (SSE). The server sends events on one HTTP response. Data
   goes in one direction only, and that is sufficient for both features.

## Decision

Use SSE (`text/event-stream`) for both features.

- `GET /api/system/stream` sends a `snapshot` event at each interval. It sends an
  `error` event when the agent fails, and the stream stays open
  ([`system.py`](../../api/src/picloud_api/routes/system.py)).
- `POST /api/chat` sends `meta`, `token`, `done` and `error` events. The browser
  reads it with `fetch` and a stream parser, because `EventSource` cannot send a
  POST ([`sse.ts`](../../web/src/lib/sse.ts)).
- The API sends `X-Accel-Buffering: no` and a `: ping` comment every 15 s
  ([`sse.py`](../../api/src/picloud_api/sse.py)).
- nginx sets `proxy_buffering off` and a read timeout of 1 hour. Its gzip list
  does not include `text/event-stream`, because compression buffers the stream.
- The browser controls reconnection. It reconnects with exponential backoff and
  jitter. A watchdog closes a stream that is silent for too long
  ([`useSystemStream.ts`](../../web/src/hooks/useSystemStream.ts)).

## Consequences

- SSE is plain HTTP, so basic auth, TLS and HTTP/2 apply with no change. On the
  laptop stack, events arrived through the gateway every 2.002 to 2.008 s
  (measured on a Docker Desktop arm64 VM).
- `EventSource` does not show comment lines to the code, and a stalled proxy can
  keep a dead stream open. Thus the client needs its own watchdog.
- Each open dashboard holds one HTTP connection. The API caches the agent
  snapshot for 1 s, so many clients cost the agent one request per second.
