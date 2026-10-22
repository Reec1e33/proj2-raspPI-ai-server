/**
 * The optional API key for POST /api/chat, kept in localStorage. Storage can
 * be unavailable (private windows, blocked site data), so every access is
 * guarded and an in-memory copy keeps the current tab working regardless.
 */
const STORAGE_KEY = 'picloud.apiKey';

const listeners = new Set<() => void>();
let memoryValue: string | null = null;

export function getApiKey(): string {
  if (memoryValue !== null) return memoryValue;
  try {
    memoryValue = localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    memoryValue = '';
  }
  return memoryValue;
}

export function setApiKey(value: string): void {
  memoryValue = value.trim();
  try {
    if (memoryValue) localStorage.setItem(STORAGE_KEY, memoryValue);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not persisted; the in-memory value still applies to this tab.
  }
  listeners.forEach((listener) => {
    listener();
  });
}

/** Subscribes to changes from this tab and from other tabs (`storage` event). */
export function subscribeApiKey(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    memoryValue = null; // re-read on next getApiKey()
    listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
