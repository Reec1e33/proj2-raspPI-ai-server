interface MeterProps {
  /** 0-100. Values outside the range are clamped for drawing only. */
  value: number;
  label: string;
  valueText: string;
  /** CSS colour of the fill; the track is a light wash of the same colour. */
  color?: string;
  className?: string;
}

/** A thin horizontal meter (ARIA `meter` role) whose track shares the fill's hue. */
export function Meter({
  value,
  label,
  valueText,
  color = 'var(--series-1)',
  className = '',
}: MeterProps) {
  const width = Math.min(100, Math.max(0, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 10) / 10}
      aria-valuetext={valueText}
      className={`h-2 overflow-hidden rounded-full ${className}`}
      style={{ backgroundColor: `color-mix(in oklab, ${color} 20%, transparent)` }}
    >
      <div
        className="h-full rounded-r-full transition-[width] duration-500"
        style={{ width: `${width}%`, backgroundColor: color }}
      />
    </div>
  );
}
