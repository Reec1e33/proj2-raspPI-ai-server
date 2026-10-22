import {
  CircleCheck,
  CircleDashed,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { Level } from '../lib/thresholds';

const ICONS: Record<Level, { icon: LucideIcon; className: string }> = {
  good: { icon: CircleCheck, className: 'text-good' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  critical: { icon: OctagonAlert, className: 'text-critical' },
  unknown: { icon: CircleDashed, className: 'text-ink-muted' },
};

interface LevelIndicatorProps {
  level: Level;
  label: string;
  className?: string;
}

/**
 * A status colour never carries meaning alone: the icon shape and the text
 * label say the same thing for colour-blind users and in forced-colours mode.
 */
export function LevelIndicator({ level, label, className = '' }: LevelIndicatorProps) {
  const { icon: Icon, className: tone } = ICONS[level];
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-ink-secondary ${className}`}
      data-level={level}
    >
      <Icon aria-hidden className={`size-3.5 shrink-0 ${tone}`} strokeWidth={2.25} />
      {label}
    </span>
  );
}
