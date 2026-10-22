/**
 * A deliberately small Markdown subset for chat answers: fenced code blocks,
 * ATX headings, bullet and numbered lists, paragraphs, inline `code` and
 * **bold**. It produces a plain data tree that React renders as text nodes,
 * so model output can never inject HTML. Links and images are not supported
 * on purpose (no untrusted URLs end up in the DOM).
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string };

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; level: number; content: Inline[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

type Draft =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | Extract<Block, { type: 'code' | 'heading' }>;

// The patterns avoid adjacent optional runs (such as `\s*#*\s*$`) that make
// the regex engine backtrack quadratically on long lines; the answer is
// re-parsed on every streamed token. FENCE is matched against a trimmed line.
const FENCE = /^(```|~~~)\s*([\w#+.-]*)$/;
const HEADING = /^(#{1,6})[ \t]+(.*)$/s;
const BULLET = /^\s*[-*+]\s+(.*)$/s;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/s;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/;

/** Heading text without trailing whitespace or an optional closing `#` sequence. */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  // A closing sequence counts only when it is the whole text or follows a space.
  if (end === 0) return '';
  return end < text.length && /\s/.test(text[end - 1] ?? '') ? text.slice(0, end).trimEnd() : text;
}

export function parseInline(text: string): Inline[] {
  // With a capturing group, split() puts the matches at the odd indices.
  return text
    .split(INLINE)
    .map((part, index): Inline => {
      if (index % 2 === 0) return { type: 'text', text: part };
      return part.startsWith('`')
        ? { type: 'code', text: part.slice(1, -1) }
        : { type: 'strong', text: part.slice(2, -2) };
    })
    .filter((node) => node.text !== '');
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const drafts: Draft[] = [];
  // The paragraph or list that the next line may continue.
  let open: Draft | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const fence = FENCE.exec(line.trim());
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      // An unterminated fence (common mid-stream) runs to the end of the text.
      while (i + 1 < lines.length && lines[i + 1]?.trim() !== marker) {
        body.push(lines[i + 1] ?? '');
        i++;
      }
      i++; // skip the closing fence
      drafts.push({ type: 'code', language: fence[2] ?? '', text: body.join('\n') });
      open = undefined;
      continue;
    }

    if (line.trim() === '') {
      open = undefined;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      drafts.push({ type: 'heading', level, content: parseInline(headingText(heading[2] ?? '')) });
      open = undefined;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const text = (bullet ? bullet[1] : numbered?.[2]) ?? '';
      if (open?.type === 'list' && open.ordered === ordered) {
        open.items.push(text);
      } else {
        open = { type: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items: [text] };
        drafts.push(open);
      }
      continue;
    }

    if (open?.type === 'list' && /^\s/.test(line)) {
      // Indented continuation of the previous list item.
      const last = open.items.length - 1;
      open.items[last] = `${open.items[last] ?? ''}\n${line.trim()}`;
      continue;
    }

    if (open?.type === 'paragraph') {
      open.lines.push(line);
    } else {
      open = { type: 'paragraph', lines: [line] };
      drafts.push(open);
    }
  }

  return drafts.map((draft): Block => {
    switch (draft.type) {
      case 'paragraph':
        return { type: 'paragraph', content: parseInline(draft.lines.join('\n')) };
      case 'list':
        return {
          type: 'list',
          ordered: draft.ordered,
          start: draft.start,
          items: draft.items.map(parseInline),
        };
      default:
        return draft;
    }
  });
}
