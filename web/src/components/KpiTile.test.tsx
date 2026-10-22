import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test/fixtures';
import { KpiGrid } from './KpiGrid';
import { KpiTile } from './KpiTile';

function temperatureTile(celsius: number | null) {
  const base = makeSnapshot();
  render(<KpiGrid snapshot={{ ...base, cpu: { ...base.cpu, temperature_celsius: celsius } }} />);
  const heading = screen.getByRole('heading', { name: 'CPU temp' });
  const tile = heading.closest('article');
  if (!tile) throw new Error('tile not found');
  return tile;
}

describe('KpiTile', () => {
  it('shows the value with an icon-and-label status', () => {
    render(<KpiTile label="CPU usage" value="12.3%" status={{ level: 'good', label: 'Normal' }} />);
    expect(screen.getByText('12.3%')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toHaveAttribute('data-level', 'good');
  });

  it('omits the status when the reading has no thresholds', () => {
    const { container } = render(<KpiTile label="Network in" value="1.2 MiB/s" />);
    expect(container.querySelector('[data-level]')).toBeNull();
  });
});

describe('KpiGrid temperature thresholds', () => {
  it.each([
    [59.9, 'good', 'Normal'],
    [60, 'warning', 'Warm'],
    [74.9, 'warning', 'Warm'],
    [75, 'critical', 'Hot'],
  ])('%d °C is %s', (celsius, level, label) => {
    const tile = temperatureTile(celsius);
    expect(tile).toHaveAttribute('data-level', level);
    expect(within(tile).getByText(label)).toBeInTheDocument();
  });

  it('reports a missing sensor instead of a temperature', () => {
    const tile = temperatureTile(null);
    expect(tile).toHaveAttribute('data-level', 'unknown');
    expect(within(tile).getByText('No sensor')).toBeInTheDocument();
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });

  it('summarises throttling as now vs. since boot', () => {
    const base = makeSnapshot();
    render(
      <KpiGrid
        snapshot={{ ...base, throttling: { ...base.throttling, under_voltage_occurred: true } }}
      />,
    );
    const tile = screen.getByRole('heading', { name: 'Throttling' }).closest('article');
    expect(tile).toHaveAttribute('data-level', 'warning');
    expect(tile).toHaveTextContent('Since boot');
    expect(tile).toHaveTextContent('Under-voltage');
  });

  it('renders placeholders before the first snapshot', () => {
    render(<KpiGrid snapshot={null} />);
    expect(screen.getAllByText('No data')).toHaveLength(6);
  });
});
