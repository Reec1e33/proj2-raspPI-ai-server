# ADR-0007: Use Server-Sent Events for live telemetry and chat

- Status: Accepted
- Date: 2026-10-02

## Context

The dashboard gets a new host sample every 2 seconds, and the chat streams the
answer token by token. Both go through nginx with TLS, HTTP/2, and basic auth.
Polling with `fetch` is simple but makes every update a full request and can't
stream tokens. WebSockets work, but they need an upgrade through nginx, their
own reconnect logic, and their own message format, all to get a second
direction that neither feature uses.

## Decision

Use SSE (`text/event-stream`) for both.
`GET /api/system/stream` sends a `snapshot` event each interval and an `error`
event when the agent fails, without closing the stream
([`system.py`](../../api/src/picloud_api/routes/system.py)). `POST /api/chat`
sends `meta`, `token`, `done`, and `error` events. The browser reads it with
`fetch` and a stream parser, since `EventSource` can't POST
([`sse.ts`](../../web/src/lib/sse.ts)). The API sets `X-Accel-Buffering: no`
and sends a `: ping` comment every 15 s
([`sse.py`](../../api/src/picloud_api/sse.py)). nginx turns off proxy buffering,
uses a 1 hour read timeout, and leaves `text/event-stream` out of gzip, because
compression buffers the stream. The client reconnects with exponential backoff
and jitter, and a watchdog kills a stream that goes quiet
([`useSystemStream.ts`](../../web/src/hooks/useSystemStream.ts)).

## Consequences

- It's plain HTTP, so basic auth, TLS, and HTTP/2 work unchanged. On the laptop
  stack, events came through the gateway every 2.002 to 2.008 s (Docker Desktop
  arm64 VM).
- `EventSource` hides comment lines from the page, and a stalled proxy can hold
  a dead stream open, so the client needs its own watchdog.
- Each open dashboard holds an HTTP connection. The API caches the agent
  snapshot for 1 s, so any number of clients costs the agent one request a
  second.
