import { useSyncExternalStore } from 'react';
import { getApiKey, subscribeApiKey } from '../lib/settings';

/** The API key from Settings; re-renders when it changes in any tab. */
export function useApiKey(): string {
  return useSyncExternalStore(subscribeApiKey, getApiKey, () => '');
}
