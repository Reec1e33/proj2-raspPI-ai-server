# PiCloud web dashboard

This is the browser dashboard for PiCloud. It shows live telemetry from the Raspberry Pi and gives a chat with the AI gateway. The nginx gateway serves the build output (`web/dist`) at `/`.

Stack: React 19, TypeScript (strict), Vite, Tailwind CSS v4, Recharts, Vitest, and Testing Library.

## Features

- A header with the hostname, Pi model, OS, kernel, uptime, and stream state (live, stale, connecting, or offline).
- KPI tiles for CPU temperature, CPU usage, memory, root disk, network rate, and throttle state. An icon and a text label show each threshold level.
- Live charts for CPU usage, CPU temperature, memory, and network throughput. Each chart shows the last 5 minutes and has a table view.
- Per-core CPU bars, a filesystem table, and the firmware throttle flags ("now" and "since boot").
- A providers panel with the fallback order, a local or cloud badge, and the circuit-breaker state.
- "Ask your Pi": a chat that streams answers from `POST /api/chat`. It shows the provider and model, the time to first token (TTFT), the total latency, and fallback notices. A Stop button cancels the answer.
- A settings dialog for the optional API key.
- A link to Grafana at `/grafana/`.

## Requirements

- Node.js 22.12 or later.
- pnpm 10. The `packageManager` field pins the version and its SHA-512 hash for Corepack.

## Commands

Run these commands in `web/`.

| Command             | Result                                                |
| ------------------- | ----------------------------------------------------- |
| `pnpm install`      | Installs the dependencies from `pnpm-lock.yaml`.      |
| `pnpm dev`          | Starts the Vite dev server on port 5173.              |
| `pnpm build`        | Type-checks the code and writes the build to `dist/`. |
| `pnpm preview`      | Serves `dist/` on port 4173, with the same API proxy. |
| `pnpm lint`         | Runs ESLint with type-aware rules.                    |
| `pnpm typecheck`    | Runs `tsc -b`.                                        |
| `pnpm test`         | Runs Vitest in watch mode. Add `--run` for one pass.  |
| `pnpm format`       | Formats all files with Prettier.                      |
| `pnpm format:check` | Fails if a file is not formatted.                     |

## Local development

The app uses only relative URLs (`/api/...`). In development, Vite forwards `/api` to the API. The default target is `http://localhost:8000`.

1. Start the agent in demo mode and the API. Refer to `agent/README.md` and `api/README.md`.
2. Start the dev server:

   ```sh
   pnpm dev
   ```

3. Open `http://localhost:5173`.

To use an API at a different address, set `VITE_API_PROXY`:

```sh
VITE_API_PROXY=http://picloud.local:8000 pnpm dev
```

You can also put `VITE_API_PROXY` in `web/.env.local`. Git ignores that file. The proxy keeps all requests on one origin, so the API needs no CORS settings for development.

## Layout

```text
src/
  api/          Contract types and the fetch client (typed errors, X-API-Key)
  lib/          Pure logic: SSE parser, ring buffer, formatters, scales, Markdown subset
  hooks/        useSystemStream, useProviders, useChat and its reducer, useApiKey
  components/   Header, tiles, panels, chat, settings dialog
  components/charts/  Recharts code (a separate chunk)
  test/         Test setup, fixtures, and an EventSource mock
```

## Design notes

### Live telemetry

- `useSystemStream` opens an `EventSource` on `/api/system/stream`. Each `snapshot` event updates the panels.
- A ring buffer keeps the samples of the last 5 minutes for the charts. The hook plots each agent sample one time.
- Samples can be missing, for example while the API or the agent is down. If the time between two samples is more than 10 s and more than three sample intervals, the charts show a break in the line. They do not draw a straight line across the missing time.
- If the host clock goes back, the hook clears the chart history.
- The client checks the structure of each snapshot. It ignores a malformed snapshot, and the dashboard continues to operate.
- The hook controls reconnection. A connection error closes the stream. Silence also closes it: 10 s without an event, or four times the largest gap between events if that is longer. Before the second event, the limit is 60 s. A stalled proxy can keep a dead stream open, and `EventSource` does not see this.
- After a close, the hook connects again with exponential backoff and jitter. The first delay is 0.5 to 1 s, and the maximum delay is 30 s.
- An `error` event from the API means that the agent is down. The stream stays open, and the badge shows "Offline".
- The stream can stay healthy while the agent stops to sample, for example when a dead mount blocks it. Then `collected_at` does not change. If it does not change for 15 s, or for three agent sample intervals if that is longer, the badge shows "Stale". The hook compares browser receive times only, so a clock difference between the browser and the Pi has no effect.
- While the stream is offline or stale, the panels keep the last snapshot at reduced opacity.

### Chat

- `useChat` sends `POST /api/chat` with `fetch` and reads the response body as a stream.
- `src/lib/sse.ts` parses the event stream incrementally. It obeys the WHATWG rules for CRLF, comments, multi-line data, and event names. It also accepts a line, a CRLF pair, or a UTF-8 character split across two chunks.
- A pure reducer (`src/hooks/chatReducer.ts`) holds the state machine: `waiting`, `streaming`, then `done`, `error`, or `stopped`.
- The Stop button aborts the request with an `AbortController`. The partial answer stays on the screen.
- Each request includes the earlier exchanges that have an answer. The client obeys the API limits (50 messages, 8000 characters each).

### Safe output

The chat renders a small Markdown subset: code blocks, headings, lists, inline code, and bold text. The parser makes a data tree, and React renders it as text nodes. The app does not use `dangerouslySetInnerHTML`. The subset has no links or images, so model output cannot put URLs on the page. The parse time increases linearly with the length of the answer, so a very long line from a model does not stop the page.

### Charts and colour

- Each measure has its own chart and its own y-axis.
- The series colours pass checks for contrast and colour-blind separation in the dark and light themes.
- In the live state, all text has a contrast ratio of 4.5:1 or more in both themes. While the stream is offline or stale, the panels dim on purpose to show that the data is old.
- A status colour always has an icon and a text label.
- Recharts loads in a separate chunk after the first paint. The initial JavaScript is about 86 kB gzip, and the chart chunk is about 106 kB gzip.

### Accessibility

- The settings dialog is a native `<dialog>`, so focus stays in the dialog and Escape closes it.
- All form controls have labels. The bars use `role="meter"`, and the chat uses `role="log"`.
- Each chart has a table view. The chart tooltip also works with the arrow keys.
- The theme is dark by default and follows `prefers-color-scheme: light`.

### Security

- The API key is optional. The API asks for it only when `PICLOUD_API_KEY` is set.
- A missing or wrong key gives HTTP 403, and the chat shows a link to the settings. A 401 comes only from the gateway's basic auth.
- The browser keeps the key in `localStorage` and sends it as `X-API-Key` with chat requests only. Any script on the page can read `localStorage`, so do not use this key for other services.
- The build has no inline scripts and no inline style elements. It works with the CSP `script-src 'self'; style-src 'self'`.

## Tests

Vitest runs the tests in jsdom. The pure modules run in the Node environment.

- `lib/*.test.ts`: the SSE parser (chunk splits, multi-byte characters, CRLF, comments, multi-line data), formatters, ring buffer, scales, Markdown subset, thresholds, and backoff.
- `hooks/chatReducer.test.ts`: the chat state machine, the conversion of events to actions, and the request history.
- `hooks/useSystemStream.test.ts`: live state, agent errors, backoff reconnection, the silence watchdog, the stale state, and gaps in the chart history.
- `api/client.test.ts`: headers, typed errors, `Retry-After`, and the checks on snapshots and provider lists.
- `components/*.test.tsx` and `App.test.tsx`: KPI thresholds, chat stream with a mocked `fetch` body, Stop, errors, and the offline and stale states.
