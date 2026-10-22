import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { FIRST_ADVANCE_TIMEOUT_MS } from './hooks/useSystemStream';
import { makeSnapshot } from './test/fixtures';
import { MockEventSource } from './test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
});

describe('App offline state', () => {
  it('shows an offline notice, not a crash, when the API is unreachable', async () => {
    render(<App />);
    act(() => MockEventSource.latest().fail());

    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.getByText('No live data yet')).toBeInTheDocument();
    expect(screen.getByTestId('connection-notice')).toHaveTextContent(
      'Lost connection to the API.',
    );
    expect(await screen.findByText('Cannot load providers')).toBeInTheDocument();
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(await screen.findAllByText('Waiting for data')).toHaveLength(4);
  });

  it('keeps the last reading visible while the agent is down', () => {
    render(<App />);
    act(() => MockEventSource.latest().emit('snapshot', makeSnapshot()));
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    const readings = () => screen.getAllByText('51.2 °C');
    expect(readings().length).toBeGreaterThan(0);

    act(() => MockEventSource.latest().emit('error', { detail: 'agent unavailable' }));

    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.getByText('Live data paused')).toBeInTheDocument();
    expect(screen.getByTestId('connection-notice')).toHaveTextContent('Agent: agent unavailable');
    expect(readings().length).toBeGreaterThan(0);
  });

  it('flags a frozen reading as stale while the stream stays connected', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const snapshot = makeSnapshot();
      act(() => MockEventSource.latest().emit('snapshot', snapshot));
      act(() => {
        vi.advanceTimersByTime(FIRST_ADVANCE_TIMEOUT_MS + 1);
        MockEventSource.latest().emit('snapshot', snapshot); // same collected_at
      });

      expect(screen.getByRole('status')).toHaveTextContent('Stale');
      expect(screen.getByText('Readings are not updating')).toBeInTheDocument();
      expect(screen.getAllByText('51.2 °C').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
