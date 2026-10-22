import { useEffect, useState } from 'react';
import { describeError, getProviders, isAbortError } from '../api/client';
import type { ProviderInfo } from '../api/types';

export interface ProvidersState {
  /** Null until the first successful load. */
  providers: ProviderInfo[] | null;
  /** Error of the most recent load; the last good list is kept. */
  error: string | null;
  loading: boolean;
}

/** Loads `/api/providers` and polls it so circuit-breaker changes show up. */
export function useProviders(pollMs = 15_000): ProvidersState {
  const [state, setState] = useState<ProvidersState>({
    providers: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let controller: AbortController | undefined;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const providers = await getProviders(controller.signal);
        setState({ providers, error: null, loading: false });
      } catch (error) {
        if (isAbortError(error)) return;
        setState((prev) => ({ ...prev, error: describeError(error), loading: false }));
      }
    };

    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [pollMs]);

  return state;
}
