import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface PanelProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A titled card; the section is labelled by its heading for screen readers. */
export function Panel({ title, description, actions, className = '', children }: PanelProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`panel flex flex-col p-4 ${className}`}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-semibold text-ink">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-ink-secondary">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  detail?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, detail, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center ${className}`}
    >
      <Icon aria-hidden className="size-5 text-ink-muted" />
      <p className="text-sm font-medium text-ink-secondary">{title}</p>
      {detail && <p className="max-w-xs text-xs text-ink-secondary">{detail}</p>}
    </div>
  );
}
