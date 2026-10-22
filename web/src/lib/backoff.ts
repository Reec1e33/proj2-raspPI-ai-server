export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injectable for tests; must return a number in [0, 1). */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": the delay for attempt n (0-based)
 * is uniformly distributed in [d/2, d), where d = min(max, base * 2^n).
 * Jitter stops many open dashboards from reconnecting in lockstep.
 */
export function backoffDelay(
  attempt: number,
  { baseMs = 1_000, maxMs = 30_000, random = Math.random }: BackoffOptions = {},
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
