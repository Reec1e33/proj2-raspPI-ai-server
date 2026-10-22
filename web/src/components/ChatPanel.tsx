import { MessageSquareText, Send, Square, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import type { ProviderInfo, ProviderName } from '../api/types';
import { MAX_CONTENT_CHARS } from '../hooks/chatReducer';
import { useChat } from '../hooks/useChat';
import { ChatMessage } from './ChatMessage';
import { EmptyState, Panel } from './Panel';

const SUGGESTIONS = [
  'Why is my Pi running hot?',
  'Is anything throttling right now?',
  'How much disk space is left?',
];

/** Distance from the bottom (px) within which new text keeps the log scrolled down. */
const STICKY_SCROLL_PX = 48;

interface ChatPanelProps {
  providers: ProviderInfo[] | null;
  apiKey: string;
  onOpenSettings: () => void;
  className?: string;
}

export function ChatPanel({ providers, apiKey, onOpenSettings, className }: ChatPanelProps) {
  const chat = useChat(apiKey);
  const [draft, setDraft] = useState('');
  const [provider, setProvider] = useState<ProviderName | ''>('');
  const [includeContext, setIncludeContext] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputId = useId();
  const providerId = useId();
  const contextId = useId();

  const enabled = providers?.filter((p) => p.enabled) ?? [];
  // A pinned provider that was disabled since it was picked falls back to auto.
  const pinned = enabled.some((p) => p.name === provider) ? (provider as ProviderName) : null;

  useEffect(() => {
    const log = logRef.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [chat.turns]);

  const submit = (text: string) => {
    if (chat.busy || text.trim() === '') return;
    stickToBottom.current = true;
    void chat.send(text, { provider: pinned, includeSystemContext: includeContext });
    setDraft('');
  };

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    submit(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(draft);
    }
  };

  return (
    <Panel
      title="Ask your Pi"
      description="Answers stream from the first healthy provider and can use live system data."
      className={className}
      actions={
        <button
          type="button"
          className="btn-ghost"
          onClick={chat.clear}
          disabled={chat.busy || chat.turns.length === 0}
        >
          <Trash2 aria-hidden className="size-4" />
          Clear
        </button>
      }
    >
      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        className="-mx-1 flex h-[26rem] flex-col gap-4 overflow-y-auto px-1 pb-2"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL_PX;
        }}
      >
        {chat.turns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <EmptyState
              icon={MessageSquareText}
              title="Ask about this Pi"
              detail="Questions about temperature, load, memory, or disk get answers based on the live readings."
              className="flex-none"
            />
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-line-strong px-3 py-1 text-xs text-ink-secondary hover:bg-raised hover:text-ink"
                  onClick={() => submit(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.turns.map((turn) => (
            <ChatMessage key={turn.id} turn={turn} onOpenSettings={onOpenSettings} />
          ))
        )}
      </div>

      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          className="input min-h-[4.5rem] resize-y"
          placeholder="Ask about temperature, load, disk… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          maxLength={MAX_CONTENT_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor={providerId} className="text-xs text-ink-secondary">
              Provider
            </label>
            <select
              id={providerId}
              className="input py-1 text-xs"
              value={pinned ?? ''}
              onChange={(event) => setProvider(event.target.value as ProviderName | '')}
            >
              <option value="">Auto (fallback order)</option>
              {enabled.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} first
                </option>
              ))}
            </select>
          </div>
          <label htmlFor={contextId} className="flex items-center gap-2 text-xs text-ink-secondary">
            <input
              id={contextId}
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={includeContext}
              onChange={(event) => setIncludeContext(event.target.checked)}
            />
            Include live system context
          </label>
          <div className="ml-auto">
            {chat.busy ? (
              <button
                type="button"
                className="btn-ghost border border-line-strong"
                onClick={chat.stop}
              >
                <Square aria-hidden className="size-3.5" />
                Stop
              </button>
            ) : (
              <button type="submit" className="btn-primary" disabled={draft.trim() === ''}>
                <Send aria-hidden className="size-4" />
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </Panel>
  );
}
