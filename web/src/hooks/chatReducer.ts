import { ApiError, NetworkError, describeError } from '../api/client';
import type {
  ChatDoneEvent,
  ChatMessage,
  ChatMetaEvent,
  ProviderFallback,
  ProviderName,
} from '../api/types';
import type { SseEvent } from '../lib/sse';

/** Request limits enforced by POST /api/chat. */
export const MAX_MESSAGES = 50;
export const MAX_CONTENT_CHARS = 8000;

/**
 * Why an answer failed. `code` is one of the API's ChatErrorCode values or a
 * client-side code: network_error, http_error, invalid_request,
 * stream_interrupted, stream_error.
 */
export interface ChatFailure {
  code: string;
  message: string;
}

/**
 * Lifecycle of one answer:
 * waiting -> streaming -> done, with error or stopped reachable from either
 * of the first two.
 */
export type AssistantStatus = 'waiting' | 'streaming' | 'done' | 'error' | 'stopped';

export interface UserTurn {
  id: string;
  role: 'user';
  content: string;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  content: string;
  status: AssistantStatus;
  provider: ProviderName | null;
  model: string | null;
  /** Providers dropped before the first token, seen as repeated `meta` events. */
  switchedFrom: ProviderName[];
  result: ChatDoneEvent | null;
  failure: ChatFailure | null;
}

export type ChatTurn = UserTurn | AssistantTurn;

export interface ChatState {
  turns: ChatTurn[];
  /** Id of the assistant turn being answered, or null when idle. */
  activeId: string | null;
}

export const initialChatState: ChatState = { turns: [], activeId: null };

export type ChatAction =
  | { type: 'send'; userId: string; assistantId: string; content: string }
  | { type: 'meta'; meta: ChatMetaEvent }
  | { type: 'token'; text: string }
  | { type: 'done'; result: ChatDoneEvent }
  | { type: 'fail'; failure: ChatFailure }
  | { type: 'stop' }
  | { type: 'clear' };

/** Applies `update` to the active turn; events that arrive while idle are ignored. */
function updateActive(
  state: ChatState,
  update: (turn: AssistantTurn) => AssistantTurn,
  { finish = false } = {},
): ChatState {
  const { activeId } = state;
  if (activeId === null) return state;
  return {
    turns: state.turns.map((turn) =>
      turn.id === activeId && turn.role === 'assistant' ? update(turn) : turn,
    ),
    activeId: finish ? null : activeId,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      if (state.activeId !== null) return state;
      return {
        turns: [
          ...state.turns,
          { id: action.userId, role: 'user', content: action.content },
          {
            id: action.assistantId,
            role: 'assistant',
            content: '',
            status: 'waiting',
            provider: null,
            model: null,
            switchedFrom: [],
            result: null,
            failure: null,
          },
        ],
        activeId: action.assistantId,
      };

    case 'meta':
      return updateActive(state, (turn) => {
        const previous = turn.provider;
        return {
          ...turn,
          provider: action.meta.provider,
          model: action.meta.model,
          switchedFrom:
            previous !== null && previous !== action.meta.provider && turn.content === ''
              ? [...turn.switchedFrom, previous]
              : turn.switchedFrom,
        };
      });

    case 'token':
      return updateActive(state, (turn) => ({
        ...turn,
        status: 'streaming',
        content: turn.content + action.text,
      }));

    case 'done':
      return updateActive(
        state,
        (turn) => ({
          ...turn,
          status: 'done',
          provider: action.result.provider,
          model: action.result.model,
          result: action.result,
        }),
        { finish: true },
      );

    case 'fail':
      return updateActive(
        state,
        (turn) => ({ ...turn, status: 'error', failure: action.failure }),
        {
          finish: true,
        },
      );

    case 'stop':
      return updateActive(state, (turn) => ({ ...turn, status: 'stopped' }), { finish: true });

    case 'clear':
      return state.activeId === null ? initialChatState : state;
  }
}

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Maps one event of the /api/chat stream to a reducer action (null = ignore). */
export function sseEventToAction(event: SseEvent): ChatAction | null {
  const data = parseObject(event.data);
  if (!data) return null;

  switch (event.event) {
    case 'meta':
      return typeof data.provider === 'string' && typeof data.model === 'string'
        ? { type: 'meta', meta: data as unknown as ChatMetaEvent }
        : null;
    case 'token':
      return typeof data.text === 'string' ? { type: 'token', text: data.text } : null;
    case 'done':
      return typeof data.provider === 'string'
        ? {
            type: 'done',
            result: {
              ...(data as unknown as ChatDoneEvent),
              fallbacks: Array.isArray(data.fallbacks)
                ? (data.fallbacks as ProviderFallback[])
                : [],
            },
          }
        : null;
    case 'error':
      return {
        type: 'fail',
        failure: {
          code: typeof data.code === 'string' ? data.code : 'provider_error',
          message: typeof data.message === 'string' ? data.message : 'The provider failed.',
        },
      };
    default:
      return null;
  }
}

/** Classifies an exception thrown while opening or reading the chat stream. */
export function failureFromError(error: unknown): ChatFailure {
  const message = describeError(error);
  if (error instanceof ApiError) {
    const codes: Record<number, string> = {
      403: 'unauthorized',
      422: 'invalid_request',
      429: 'rate_limited',
      503: 'all_providers_failed',
    };
    return { code: codes[error.status] ?? 'http_error', message };
  }
  if (error instanceof NetworkError) return { code: 'network_error', message };
  return { code: 'stream_error', message };
}

/** Cuts `text` to the API limit without splitting a UTF-16 surrogate pair. */
function clip(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  const cut = text.slice(0, MAX_CONTENT_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The messages for a new question: earlier exchanges that produced text
 * (complete or stopped), then the new question. Exchanges whose answer failed
 * without any text are dropped, so asking again does not send the question
 * twice. Content and count are trimmed to the API limits, keeping the newest
 * messages; the odd count keeps a user message first.
 */
export function buildRequestMessages(turns: readonly ChatTurn[], question: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i + 1 < turns.length; i += 2) {
    const user = turns[i];
    const assistant = turns[i + 1];
    if (user?.role !== 'user' || assistant?.role !== 'assistant') continue;
    const answer = assistant.content.trim();
    if (answer === '' || assistant.status === 'waiting' || assistant.status === 'streaming') {
      continue;
    }
    messages.push(
      { role: 'user', content: clip(user.content) },
      { role: 'assistant', content: clip(answer) },
    );
  }
  messages.push({ role: 'user', content: clip(question) });
  return messages.slice(-(MAX_MESSAGES - 1));
}
