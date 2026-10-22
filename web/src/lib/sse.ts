/**
 * Incremental parser for `text/event-stream`, following the WHATWG HTML
 * "Server-sent events" interpretation rules:
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * It accepts input in arbitrary chunks: a line, a CRLF pair, or a multi-byte
 * UTF-8 character may be split across chunk boundaries.
 */

export interface SseEvent {
  /** The `event:` field, or "message" when the stream did not set one. */
  event: string;
  /** All `data:` lines of the event, joined with "\n". */
  data: string;
  /** The last event ID seen on the stream (it persists across events). */
  lastEventId: string;
}

const LF = 0x0a;
const CR = 0x0d;

export class SseParser {
  #line = '';
  #skipNextLF = false;
  #data: string[] = [];
  #eventType = '';
  #lastEventId = '';

  /** Reconnection time requested with a `retry:` field, in milliseconds. */
  retryMs: number | null = null;

  /** Feeds decoded text and returns the events completed by it. */
  feed(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (this.#skipNextLF) {
        this.#skipNextLF = false;
        if (code === LF) {
          // Second half of a CRLF whose CR ended the previous line.
          start = i + 1;
          continue;
        }
      }
      if (code !== CR && code !== LF) continue;

      const line = this.#line + text.slice(start, i);
      this.#line = '';
      start = i + 1;
      this.#skipNextLF = code === CR;

      const event = this.#processLine(line);
      if (event) events.push(event);
    }

    this.#line += text.slice(start);
    return events;
  }

  #processLine(line: string): SseEvent | null {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return null; // comment, e.g. ": ping"

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.#lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        // Unknown fields are ignored.
        break;
    }
    return null;
  }

  #dispatch(): SseEvent | null {
    const hasData = this.#data.length > 0;
    const event: SseEvent = {
      event: this.#eventType || 'message',
      data: this.#data.join('\n'),
      lastEventId: this.#lastEventId,
    };
    this.#data = [];
    this.#eventType = '';
    return hasData ? event : null;
  }
}

/**
 * Reads a byte stream and yields each complete event. An event that is not
 * terminated by a blank line before the stream ends is discarded, as the spec
 * requires. Leaving the loop early cancels the underlying stream.
 */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  // TextDecoder strips a leading BOM and, with { stream: true }, buffers
  // incomplete multi-byte sequences until the next chunk arrives.
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  let finished = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
