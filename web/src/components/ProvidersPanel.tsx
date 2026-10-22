import { Cloud, PlugZap, Server, ServerOff } from 'lucide-react';
import type { CircuitState, ProviderInfo } from '../api/types';
import type { ProvidersState } from '../hooks/useProviders';
import type { Level } from '../lib/thresholds';
import { LevelIndicator } from './LevelIndicator';
import { EmptyState, Panel } from './Panel';

const CIRCUIT: Record<CircuitState, { level: Level; label: string }> = {
  closed: { level: 'good', label: 'Closed' },
  half_open: { level: 'warning', label: 'Half-open' },
  open: { level: 'critical', label: 'Open' },
};

function LocalityBadge({ local }: { local: boolean }) {
  const Icon = local ? Server : Cloud;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-secondary">
      <Icon aria-hidden className="size-3" />
      {local ? 'Local' : 'Cloud'}
    </span>
  );
}

function ProviderRow({ provider, position }: { provider: ProviderInfo; position: number }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="w-4 text-xs text-ink-secondary tabular-nums" aria-hidden>
        {position}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{provider.name}</span>
          <LocalityBadge local={provider.local} />
        </div>
        <p className="truncate font-mono text-xs text-ink-secondary" title={provider.model}>
          {provider.model}
        </p>
      </div>
      {provider.enabled ? (
        <LevelIndicator
          level={CIRCUIT[provider.circuit].level}
          label={CIRCUIT[provider.circuit].label}
        />
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-ink-secondary">
          <ServerOff aria-hidden className="size-3.5 text-ink-muted" />
          Disabled
        </span>
      )}
    </li>
  );
}

interface ProvidersPanelProps {
  state: ProvidersState;
  className?: string;
}

export function ProvidersPanel({ state, className }: ProvidersPanelProps) {
  const { providers, error, loading } = state;
  return (
    <Panel
      title="AI providers"
      description="Fallback order, first tried at the top"
      className={className}
    >
      {providers && providers.length > 0 ? (
        <>
          <ol className="divide-y divide-line">
            {providers.map((provider, index) => (
              <ProviderRow key={provider.name} provider={provider} position={index + 1} />
            ))}
          </ol>
          <p className="mt-3 border-t border-line pt-3 text-xs text-ink-secondary">
            Circuit breaker: an open circuit skips the provider after repeated failures; half-open
            lets one request through to test it.
          </p>
          {error && <p className="mt-2 text-xs text-ink-secondary">Last refresh failed: {error}</p>}
        </>
      ) : providers ? (
        <EmptyState
          icon={PlugZap}
          title="No providers configured"
          detail="Configure Ollama, ANTHROPIC_API_KEY, or OPENAI_API_KEY on the API service."
        />
      ) : loading ? (
        <EmptyState icon={PlugZap} title="Loading providers…" />
      ) : (
        <EmptyState icon={ServerOff} title="Cannot load providers" detail={error} />
      )}
    </Panel>
  );
}
