// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../api/client';
import type { ChatDoneEvent } from '../api/types';
import {
  type AssistantTurn,
  type ChatAction,
  type ChatState,
  type ChatTurn,
  MAX_CONTENT_CHARS,
  MAX_MESSAGES,
  buildRequestMessages,
  chatReducer,
  failureFromError,
  initialChatState,
  sseEventToAction,
} from './chatReducer';

const DONE: ChatDoneEvent = {
  provider: 'ollama',
  model: 'llama3.2:1b',
  usage: { input_tokens: 12, output_tokens: 34 },
  latency_ms: 812,
  ttft_ms: 230,
  fallbacks: [],
};

function run(...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, initialChatState);
}

const send: ChatAction = { type: 'send', userId: 'u1', assistantId: 'a1', content: 'Hi' };

function assistant(state: ChatState): AssistantTurn {
  const turn = state.turns.at(-1);
  if (turn?.role !== 'assistant') throw new Error('expected an assistant turn');
  return turn;
}

describe('chatReducer', () => {
  it('starts a waiting answer on send and ignores a second send while busy', () => {
    const state = run(send, { ...send, userId: 'u2', assistantId: 'a2' });
    expect(state.turns.map((t) => t.id)).toEqual(['u1', 'a1']);
    expect(state.activeId).toBe('a1');
    expect(assistant(state).status).toBe('waiting');
  });

  it('streams tokens into the active answer', () => {
    const state = run(
      send,
      { type: 'meta', meta: { request_id: 'r1', provider: 'ollama', model: 'llama3.2:1b' } },
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo' },
    );
    expect(assistant(state)).toMatchObject({
      status: 'streaming',
      content: 'Hello',
      provider: 'ollama',
      model: 'llama3.2:1b',
    });
  });

  it('records a provider switch announced by a repeated meta event', () => {
    const state = run(
      send,
      { type: 'meta', meta: { request_id: 'r1', provider: 'ollama', model: 'llama3.2:1b' } },
      {
        type: 'meta',
        meta: { request_id: 'r1', provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    );
    expect(assistant(state)).toMatchObject({ provider: 'anthropic', switchedFrom: ['ollama'] });
  });

  it('completes on done and ignores late events', () => {
    const state = run(
      send,
      { type: 'token', text: 'Hi' },
      { type: 'done', result: DONE },
      {
        type: 'token',
        text: ' late',
      },
    );
    expect(state.activeId).toBeNull();
    expect(assistant(state)).toMatchObject({ status: 'done', content: 'Hi', result: DONE });
  });

  it('keeps partial text on error and on stop', () => {
    const failed = run(
      send,
      { type: 'token', text: 'Par' },
      {
        type: 'fail',
        failure: { code: 'provider_error', message: 'boom' },
      },
    );
    expect(assistant(failed)).toMatchObject({ status: 'error', content: 'Par' });
    expect(failed.activeId).toBeNull();

    const stopped = run(send, { type: 'token', text: 'Par' }, { type: 'stop' });
    expect(assistant(stopped)).toMatchObject({ status: 'stopped', content: 'Par' });
  });

  it('clears only when idle', () => {
    expect(run(send, { type: 'clear' }).turns).toHaveLength(2);
    expect(run(send, { type: 'stop' }, { type: 'clear' })).toEqual(initialChatState);
  });
});

describe('sseEventToAction', () => {
  const event = (name: string, data: unknown) => ({
    event: name,
    data: typeof data === 'string' ? data : JSON.stringify(data),
    lastEventId: '',
  });

  it('maps each contract event', () => {
    expect(sseEventToAction(event('token', { text: 'x' }))).toEqual({ type: 'token', text: 'x' });
    expect(
      sseEventToAction(event('meta', { request_id: 'r', provider: 'ollama', model: 'm' })),
    ).toMatchObject({ type: 'meta' });
    expect(
      sseEventToAction(event('error', { code: 'rate_limited', message: 'slow down' })),
    ).toEqual({ type: 'fail', failure: { code: 'rate_limited', message: 'slow down' } });
  });

  it('defaults a missing fallbacks list on done', () => {
    const withoutFallbacks: Partial<ChatDoneEvent> = { ...DONE };
    delete withoutFallbacks.fallbacks;
    const action = sseEventToAction(event('done', withoutFallbacks));
    expect(action).toMatchObject({ type: 'done', result: { fallbacks: [] } });
  });

  it('ignores malformed or unknown events', () => {
    expect(sseEventToAction(event('token', '{not json'))).toBeNull();
    expect(sseEventToAction(event('token', { text: 5 }))).toBeNull();
    expect(sseEventToAction(event('mystery', { a: 1 }))).toBeNull();
  });
});

describe('buildRequestMessages', () => {
  const pair = (n: number, answer: string, status: AssistantTurn['status']): ChatTurn[] => [
    { id: `u${n}`, role: 'user', content: `q${n}` },
    {
      id: `a${n}`,
      role: 'assistant',
      content: answer,
      status,
      provider: null,
      model: null,
      switchedFrom: [],
      result: null,
      failure: null,
    },
  ];

  it('sends answered exchanges and drops failed ones without text', () => {
    const turns = [
      ...pair(1, 'a1', 'done'),
      ...pair(2, '', 'error'),
      ...pair(3, 'part', 'stopped'),
    ];
    expect(buildRequestMessages(turns, 'next')).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'part' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('keeps the newest messages within the limit, starting with a user message', () => {
    const turns = Array.from({ length: 40 }, (_, i) => pair(i, `a${i}`, 'done')).flat();
    const messages = buildRequestMessages(turns, 'next');
    expect(messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(messages[0]?.role).toBe('user');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'next' });
  });

  it('truncates long content to the API limit', () => {
    const [message] = buildRequestMessages([], 'x'.repeat(MAX_CONTENT_CHARS + 10));
    expect(message?.content).toHaveLength(MAX_CONTENT_CHARS);
  });

  it('does not split a surrogate pair at the limit', () => {
    // 'x' + emoji puts the limit between the two halves of an emoji.
    const [message] = buildRequestMessages([], `x${'🍓'.repeat(MAX_CONTENT_CHARS)}`);
    expect(message?.content).toHaveLength(MAX_CONTENT_CHARS - 1);
    expect(message?.content.endsWith('🍓')).toBe(true);
  });
});

describe('failureFromError', () => {
  it('classifies HTTP and network errors', () => {
    expect(failureFromError(new ApiError('nope', 403)).code).toBe('unauthorized');
    // A 401 comes from the gateway's basic auth, not from the API key.
    expect(failureFromError(new ApiError('nope', 401))).toEqual({
      code: 'http_error',
      message: 'The gateway asked for the site password again. Reload the page.',
    });
    expect(failureFromError(new ApiError('slow', 429, 7))).toEqual({
      code: 'rate_limited',
      message: 'Too many requests. Try again in 7 s.',
    });
    expect(failureFromError(new ApiError('teapot', 418)).code).toBe('http_error');
    expect(failureFromError(new NetworkError('down')).code).toBe('network_error');
  });
});
