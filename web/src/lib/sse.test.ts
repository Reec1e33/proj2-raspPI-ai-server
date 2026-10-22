// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SseParser, type SseEvent, readSseStream } from './sse';

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSseStream(stream)) events.push(event);
  return events;
}

/** Feeds `text` to a fresh parser in pieces of `size` characters. */
function parseInPieces(text: string, size: number): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (let i = 0; i < text.length; i += size) events.push(...parser.feed(text.slice(i, i + size)));
  return events;
}

describe('SseParser', () => {
  it('parses named events and defaults the type to "message"', () => {
    const events = new SseParser().feed('event: token\ndata: {"text":"Hi"}\n\ndata: plain\n\n');
    expect(events).toEqual([
      { event: 'token', data: '{"text":"Hi"}', lastEventId: '' },
      { event: 'message', data: 'plain', lastEventId: '' },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    const [event] = new SseParser().feed('data: line one\ndata: line two\ndata:\n\n');
    expect(event?.data).toBe('line one\nline two\n');
  });

  it('ignores comments such as keep-alive pings', () => {
    const events = new SseParser().feed(': ping\n\n:another\ndata: x\n: mid-event comment\n\n');
    expect(events).toEqual([{ event: 'message', data: 'x', lastEventId: '' }]);
  });

  it('accepts CRLF, CR and LF line endings', () => {
    const events = new SseParser().feed('data: a\r\n\r\ndata: b\r\rdata: c\n\n');
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('handles a CRLF pair split across chunks without an extra blank line', () => {
    const parser = new SseParser();
    expect(parser.feed('data: a\r')).toEqual([]);
    // The LF completes the CRLF; only the following CRLF ends the event.
    expect(parser.feed('\ndata: b\r')).toEqual([]);
    expect(parser.feed('\n\r\n').map((e) => e.data)).toEqual(['a\nb']);
  });

  it('produces the same events however the text is chunked', () => {
    const text =
      'event: meta\r\ndata: {"provider":"ollama"}\r\n\r\n: ping\n\nevent: token\ndata: one\ndata: two\n\n';
    const whole = new SseParser().feed(text);
    expect(whole).toHaveLength(2);
    for (const size of [1, 2, 3, 5, 7]) expect(parseInPieces(text, size)).toEqual(whole);
  });

  it('removes only one leading space from the value', () => {
    const [event] = new SseParser().feed('data:  indented\n\ndata:no-space\n\n');
    expect(event?.data).toBe(' indented');
    expect(new SseParser().feed('data:no-space\n\n')[0]?.data).toBe('no-space');
  });

  it('treats a field without a colon as having an empty value', () => {
    expect(new SseParser().feed('data\n\n')).toEqual([
      { event: 'message', data: '', lastEventId: '' },
    ]);
  });

  it('does not dispatch an event that has no data lines', () => {
    const parser = new SseParser();
    expect(parser.feed('event: meta\n\n')).toEqual([]);
    // The event type must not leak into the next event.
    expect(parser.feed('data: x\n\n')[0]?.event).toBe('message');
  });

  it('tracks the last event id and the retry interval', () => {
    const parser = new SseParser();
    const events = parser.feed('id: 7\nretry: 2500\ndata: a\n\ndata: b\n\nretry: soon\n');
    expect(events.map((e) => e.lastEventId)).toEqual(['7', '7']);
    expect(parser.retryMs).toBe(2500);
  });

  it('ignores unknown fields', () => {
    expect(new SseParser().feed('foo: bar\ndata: x\n\n')).toHaveLength(1);
  });
});

describe('readSseStream', () => {
  it('reassembles multi-byte UTF-8 characters split across chunks', async () => {
    const bytes = encoder.encode('data: héllo 🍓 Ω\n\n');
    // One byte per chunk splits every multi-byte sequence.
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    const events = await collect(streamOf(chunks));
    expect(events).toEqual([{ event: 'message', data: 'héllo 🍓 Ω', lastEventId: '' }]);
  });

  it('strips a leading byte-order mark', async () => {
    const bytes = encoder.encode('﻿data: x\n\n');
    expect((await collect(streamOf([bytes])))[0]?.data).toBe('x');
  });

  it('discards a trailing event that was not terminated by a blank line', async () => {
    const events = await collect(streamOf([encoder.encode('data: done\n\ndata: partial\n')]));
    expect(events.map((e) => e.data)).toEqual(['done']);
  });

  it('cancels the source stream when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSseStream(stream)) {
      expect(event.data).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
