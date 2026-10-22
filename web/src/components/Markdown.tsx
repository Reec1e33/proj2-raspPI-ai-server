import { type Inline, parseMarkdown } from '../lib/markdown';

function InlineContent({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'code':
        return (
          <code key={index} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={index} className="font-semibold text-ink">
            {node.text}
          </strong>
        );
      default:
        return node.text;
    }
  });
}

/**
 * Renders the safe Markdown subset from lib/markdown as React elements. All
 * model text becomes text nodes; nothing is parsed as HTML.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
      {parseMarkdown(source).map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <p key={index} className="font-semibold text-ink">
                <InlineContent nodes={block.content} />
              </p>
            );
          case 'code':
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-xs leading-normal whitespace-pre"
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag
                key={index}
                start={block.ordered ? block.start : undefined}
                className={`flex flex-col gap-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineContent nodes={item} />
                  </li>
                ))}
              </ListTag>
            );
          }
          default:
            return (
              <p key={index}>
                <InlineContent nodes={block.content} />
              </p>
            );
        }
      })}
    </div>
  );
}
