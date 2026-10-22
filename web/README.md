# PiCloud dashboard

The browser side of PiCloud: live Pi telemetry (tiles, charts, per-core bars,
filesystems, throttle flags, provider status) and the "Ask your Pi" chat. In
production the nginx gateway serves the built `dist/` at `/`.

React 19, strict TypeScript, Vite, Tailwind CSS v4 and Recharts. Tests use
Vitest and Testing Library.

## Running it locally

You need Node.js 22.12+ and pnpm 10 (pinned in `packageManager`, so Corepack
will pick the right one).

Start the agent in demo mode and the API first (see the
[agent](../agent/README.md) and [API](../api/README.md) READMEs), then:

```sh
cd web
pnpm install
pnpm dev          # http://localhost:5173
```

The app only uses relative `/api/...` URLs. Vite proxies `/api` to
`http://localhost:8000`, so the API doesn't need CORS settings for this. To
point it somewhere else, set `VITE_API_PROXY` in the shell or in
`web/.env.local` (git-ignored):

```sh
VITE_API_PROXY=http://picloud.local:8000 pnpm dev
```

`pnpm build` type-checks and writes `dist/`. `pnpm preview` serves that on port
4173 with the same proxy.

## Tests and checks

```sh
pnpm test --run    # plain `pnpm test` watches
pnpm lint
pnpm typecheck
pnpm format:check  # `pnpm format` to fix
```

Component and hook tests run in jsdom. The pure logic in `src/lib/` and the
chat reducer run in the Node environment.

## Layout

```text
src/
  api/                fetch client, contract types
  lib/                SSE parser, ring buffer, formatters, Markdown subset
  hooks/              useSystemStream, useChat + chatReducer, useProviders, useApiKey
  components/         header, tiles, panels, chat, settings dialog
  components/charts/  Recharts code, loaded lazily
  test/               setup, fixtures, EventSource mock
```

## Design notes

- **The stream hook handles reconnection itself.** `useSystemStream` closes the
  `EventSource` on an error or when it goes quiet for too long, then reconnects
  with jittered backoff. A stalled proxy can hold a dead connection open
  without `EventSource` ever noticing, which is why there's a silence
  watchdog.
- **"Offline" and "Stale" are different.** An `error` event from the API means
  the agent is down. Stale means events still arrive but `collected_at` stopped
  moving, for example when a hung mount blocks the agent. That check only uses
  browser receive times, so clock skew between the browser and the Pi doesn't
  matter. Either way the panels keep the last data, dimmed.
- **Charts show gaps.** If samples go missing, the line breaks instead of
  drawing a straight segment across the hole. History resets if the Pi's clock
  jumps backwards.
- **Chat streams over `fetch`.** `POST /api/chat` can't use `EventSource`, so
  [`sse.ts`](src/lib/sse.ts) parses the body incrementally, including events,
  CRLFs and UTF-8 characters split across chunks. Stop aborts the request and
  keeps the partial answer.
- **Model output is never HTML.** The chat renders a small Markdown subset
  (code, headings, lists, bold) as React text nodes, with no
  `dangerouslySetInnerHTML` and no links or images. The parser is linear, so a
  huge single-line answer can't hang the tab.
- **The API key lives in `localStorage`.** It's only needed when the API sets
  `PICLOUD_API_KEY`, and it's only sent with chat requests. Any script on the
  page can read it, so don't reuse it elsewhere. A bad key comes back as 403
  (401 belongs to the gateway's basic auth) and the chat links to settings.
- **No inline scripts or `<style>` tags** in the build, so it runs under
  `script-src 'self'`. Every status colour also has an icon and a text label,
  and each chart has a table view.
