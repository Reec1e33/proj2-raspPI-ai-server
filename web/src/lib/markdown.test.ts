// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('splits code spans and bold text', () => {
    expect(parseInline('Run `vcgencmd measure_temp` **now**.')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'vcgencmd measure_temp' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'now' },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves unmatched markers and HTML as plain text', () => {
    expect(parseInline('a * b ` c <b>x</b>')).toEqual([
      { type: 'text', text: 'a * b ` c <b>x</b>' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('parses paragraphs, headings and lists', () => {
    const blocks = parseMarkdown(
      '## Status\nAll good.\nStill good.\n\n- one\n- two\n\n3. three\n4. four',
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 2, content: [{ type: 'text', text: 'Status' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'All good.\nStill good.' }] },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [[{ type: 'text', text: 'three' }], [{ type: 'text', text: 'four' }]],
      },
    ]);
  });

  it('keeps fenced code verbatim, including Markdown inside it', () => {
    const blocks = parseMarkdown('Try:\n```bash\nsudo apt update\n# not a heading\n```\nDone.');
    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Try:' }] },
      { type: 'code', language: 'bash', text: 'sudo apt update\n# not a heading' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  it('renders an unterminated fence (mid-stream) as code to the end', () => {
    expect(parseMarkdown('```\nhalf written')).toEqual([
      { type: 'code', language: '', text: 'half written' },
    ]);
  });

  it('appends indented lines to the previous list item', () => {
    const [list] = parseMarkdown('- first\n  continued\n- second');
    expect(list).toMatchObject({
      type: 'list',
      items: [[{ type: 'text', text: 'first\ncontinued' }], [{ type: 'text', text: 'second' }]],
    });
  });

  it('strips an optional closing hash sequence from headings only after a space', () => {
    const headings = parseMarkdown('## Status ##\n# C#\n# ###').map((block) =>
      block.type === 'heading' ? block.content.map((node) => node.text).join('') : null,
    );
    expect(headings).toEqual(['Status', 'C#', '']);
  });

  it('parses long hostile lines in linear time', () => {
    // A small model stuck in a whitespace loop must not freeze the chat, which
    // re-parses the whole answer on every token.
    const spaces = ' '.repeat(50_000);
    const started = performance.now();
    parseMarkdown(`# ${spaces}x\n\`\`\`${spaces}!\n- ${spaces}\u2028x\n1. ${spaces}\u2029x`);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('normalises CRLF input', () => {
    expect(parseMarkdown('a\r\nb')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a\nb' }] },
    ]);
  });
});
