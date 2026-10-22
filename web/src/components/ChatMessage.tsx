import { Bot, Loader2, OctagonAlert, Shuffle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AssistantTurn, ChatTurn } from '../hooks/chatReducer';
import { formatMs } from '../lib/format';
import { Markdown } from './Markdown';

function Notice({
  icon: Icon,
  iconClassName,
  children,
}: {
  icon: LucideIcon;
  iconClassName: string;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-xs text-ink-secondary">
      <Icon aria-hidden className={`mt-px size-3.5 shrink-0 ${iconClassName}`} />
      <span>{children}</span>
    </p>
  );
}

const humanize = (reason: string) => reason.replaceAll('_', ' ');

function AssistantMessage({
  turn,
  onOpenSettings,
}: {
  turn: AssistantTurn;
  onOpenSettings: () => void;
}) {
  const { result, failure } = turn;
  const fallbacks = result?.fallbacks ?? [];

  return (
    <article className="flex flex-col gap-2" aria-busy={turn.status === 'streaming'}>
      <header className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
        <Bot aria-hidden className="size-4 text-ink-secondary" />
        {turn.provider ? (
          <>
            <span className="sr-only">Answer from</span>
            <span
              className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink"
              data-testid="provider-badge"
            >
              {turn.provider} · {turn.model}
            </span>
          </>
        ) : (
          <span>{turn.status === 'waiting' ? 'Connecting…' : 'No provider answered'}</span>
        )}
      </header>

      {fallbacks.length > 0 && result ? (
        <Notice icon={Shuffle} iconClassName="text-warning">
          Fallback: {fallbacks.map((f) => `${f.provider} (${humanize(f.reason)})`).join(', ')}{' '}
          failed, so {result.provider} answered.
        </Notice>
      ) : (
        turn.switchedFrom.length > 0 && (
          <Notice icon={Shuffle} iconClassName="text-warning">
            Switched provider after {turn.switchedFrom.join(', ')} failed.
          </Notice>
        )
      )}

      {turn.content ? (
        <Markdown source={turn.content} />
      ) : (
        turn.status === 'waiting' && (
          <p className="flex items-center gap-2 text-sm text-ink-secondary">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Waiting for the first token…
          </p>
        )
      )}

      {turn.status === 'streaming' && (
        <p className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-series-1" />
          Generating…
        </p>
      )}

      {result && (
        <p className="text-xs text-ink-secondary tabular-nums" data-testid="chat-stats">
          TTFT {formatMs(result.ttft_ms)} · total {formatMs(result.latency_ms)} ·{' '}
          {result.usage.output_tokens} tokens
        </p>
      )}

      {turn.status === 'stopped' && <p className="text-xs text-ink-secondary">Stopped.</p>}

      {failure && (
        <Notice icon={OctagonAlert} iconClassName="text-critical">
          {failure.message}
          {failure.code === 'unauthorized' && (
            <>
              {' '}
              <button type="button" className="text-link underline" onClick={onOpenSettings}>
                Open settings
              </button>
            </>
          )}
        </Notice>
      )}
    </article>
  );
}

export function ChatMessage({
  turn,
  onOpenSettings,
}: {
  turn: ChatTurn;
  onOpenSettings: () => void;
}) {
  if (turn.role === 'assistant') {
    return <AssistantMessage turn={turn} onOpenSettings={onOpenSettings} />;
  }
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-raised px-3 py-2 text-sm break-words whitespace-pre-wrap text-ink">
        <span className="sr-only">You asked: </span>
        {turn.content}
      </p>
    </div>
  );
}
