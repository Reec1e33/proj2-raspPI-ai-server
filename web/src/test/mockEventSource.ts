/** Minimal EventSource stand-in that tests drive by hand. */
export class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];

  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  static latest(): MockEventSource {
    const latest = MockEventSource.instances.at(-1);
    if (!latest) throw new Error('No EventSource was created');
    return latest;
  }

  static reset(): void {
    MockEventSource.instances = [];
  }

  close(): void {
    this.closed = true;
  }

  /** A server-sent event such as `event: snapshot`. */
  emit(type: string, data: unknown): void {
    this.dispatchEvent(
      new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  }

  /** A connection failure (plain Event, not a MessageEvent). */
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}
