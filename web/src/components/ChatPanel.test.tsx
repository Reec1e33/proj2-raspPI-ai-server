import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, sse, sseResponse } from '../test/fixtures';
import { ChatPanel } from './ChatPanel';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function renderPanel(apiKey = '') {
  const onOpenSettings = vi.fn();
  render(<ChatPanel providers={PROVIDERS} apiKey={apiKey} onOpenSettings={onOpenSettings} />);
  return { onOpenSettings, user: userEvent.setup() };
}

function requestBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

describe('ChatPanel', () => {
  it('streams an answer with provider badge, timings and fallback notice', async () => {
    const meta = sse('meta', { request_id: 'r1', provider: 'ollama', model: 'llama3.2:1b' });
    const done = sse('done', {
      provider: 'ollama',
      model: 'llama3.2:1b',
      usage: { input_tokens: 12, output_tokens: 34 },
      latency_ms: 812,
      ttft_ms: 230,
      fallbacks: [{ provider: 'anthropic', reason: 'rate_limited' }],
    });
    const tokens = sse('token', { text: 'Your Pi is ' }) + sse('token', { text: '**cool**.' });
    // Split chunks mid-event to exercise the incremental parser.
    fetchMock.mockResolvedValue(
      sseResponse([meta.slice(0, 20), meta.slice(20) + tokens.slice(0, 9), tokens.slice(9), done]),
    );
    const { user } = renderPanel('secret');

    await user.type(screen.getByLabelText('Message'), 'Why is my Pi hot?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('cool')).toBeInTheDocument();
    expect(screen.getByText(/Your Pi is/)).toBeInTheDocument();
    expect(screen.getByTestId('provider-badge')).toHaveTextContent('ollama · llama3.2:1b');
    expect(screen.getByTestId('chat-stats')).toHaveTextContent('TTFT 230 ms · total 812 ms');
    expect(screen.getByText(/anthropic \(rate limited\) failed, so ollama answered/)).toBeVisible();

    expect(requestBody()).toMatchObject({
      messages: [{ role: 'user', content: 'Why is my Pi hot?' }],
      provider: null,
      include_system_context: true,
      stream: true,
    });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('X-API-Key')).toBe('secret');
  });

  it('pins the chosen provider and honours the context toggle', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([sse('error', { code: 'provider_error', message: 'x' })]),
    );
    const { user } = renderPanel();

    await user.selectOptions(screen.getByLabelText('Provider'), 'anthropic');
    await user.click(screen.getByLabelText('Include live system context'));
    await user.type(screen.getByLabelText('Message'), 'Hello{Enter}');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(requestBody()).toMatchObject({ provider: 'anthropic', include_system_context: false });
    // The disabled provider is not offered.
    expect(screen.queryByRole('option', { name: /openai/ })).toBeNull();
  });

  it('stops a streaming answer and keeps the partial text', async () => {
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        sseResponse([sse('token', { text: 'Partial answer' })], {
          keepOpen: true,
          signal: init?.signal,
        }),
      ),
    );
    const { user } = renderPanel();

    await user.type(screen.getByLabelText('Message'), 'Long question{Enter}');
    expect(await screen.findByText('Partial answer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('Stopped.')).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('explains a rejected API key and links to settings', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'invalid or missing API key' }), { status: 403 }),
    );
    const { user, onOpenSettings } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Why is my Pi running hot?' }));

    expect(await screen.findByText(/API key is missing or wrong/)).toBeInTheDocument();
    expect(screen.getByText('No provider answered')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('reports a stream that ends without a done event', async () => {
    fetchMock.mockResolvedValue(sseResponse([sse('token', { text: 'Cut' })]));
    const { user } = renderPanel();

    await user.type(screen.getByLabelText('Message'), 'Hi{Enter}');

    expect(await screen.findByText('The answer stopped before it was complete.')).toBeVisible();
  });
});
