import { useCallback, useEffect, useReducer, useRef } from 'react';
import { openChatStream } from '../api/client';
import type { ProviderName } from '../api/types';
import { readSseStream } from '../lib/sse';
import {
  type ChatTurn,
  buildRequestMessages,
  chatReducer,
  failureFromError,
  initialChatState,
  sseEventToAction,
} from './chatReducer';

export interface SendOptions {
  /** Provider to try first; null lets the API use its fallback order. */
  provider: ProviderName | null;
  includeSystemContext: boolean;
}

export interface ChatController {
  turns: ChatTurn[];
  /** True from send until done, error, or stop. */
  busy: boolean;
  send: (question: string, options: SendOptions) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

/** Streams answers from POST /api/chat into the chat state machine. */
export function useChat(apiKey: string): ChatController {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const controllerRef = useRef<AbortController | null>(null);
  const idCounter = useRef(0);

  // Cancel an in-flight answer when the component unmounts.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const send = useCallback(
    async (question: string, { provider, includeSystemContext }: SendOptions) => {
      const content = question.trim();
      if (content === '' || controllerRef.current) return;

      const controller = new AbortController();
      controllerRef.current = controller;
      const messages = buildRequestMessages(state.turns, content);
      const id = ++idCounter.current;
      dispatch({ type: 'send', userId: `user-${id}`, assistantId: `assistant-${id}`, content });

      try {
        const body = await openChatStream(
          {
            messages,
            provider,
            model: null,
            include_system_context: includeSystemContext,
            stream: true,
            max_tokens: null,
            temperature: null,
          },
          { signal: controller.signal, apiKey },
        );

        let finished = false;
        for await (const event of readSseStream(body)) {
          const action = sseEventToAction(event);
          if (!action) continue;
          dispatch(action);
          if (action.type === 'done' || action.type === 'fail') {
            finished = true;
            break;
          }
        }
        if (!finished) {
          dispatch({
            type: 'fail',
            failure: {
              code: 'stream_interrupted',
              message: 'The answer stopped before it was complete.',
            },
          });
        }
      } catch (error) {
        if (controller.signal.aborted) dispatch({ type: 'stop' });
        else dispatch({ type: 'fail', failure: failureFromError(error) });
      } finally {
        controllerRef.current = null;
      }
    },
    [state.turns, apiKey],
  );

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  return { turns: state.turns, busy: state.activeId !== null, send, stop, clear };
}
