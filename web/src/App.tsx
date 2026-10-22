import { ChartLine } from 'lucide-react';
import { type ReactNode, Suspense, lazy, useState } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { ConnectionNotice } from './components/ConnectionStatus';
import { CoreBars } from './components/CoreBars';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FilesystemTable } from './components/FilesystemTable';
import { Header } from './components/Header';
import { KpiGrid } from './components/KpiGrid';
import { EmptyState } from './components/Panel';
import { ProvidersPanel } from './components/ProvidersPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { ThrottleStatus } from './components/ThrottleStatus';
import { useApiKey } from './hooks/useApiKey';
import { useProviders } from './hooks/useProviders';
import { HISTORY_WINDOW_MS, useSystemStream } from './hooks/useSystemStream';

// Recharts is the largest dependency; load it after the first paint.
const SystemCharts = lazy(() => import('./components/charts/SystemCharts'));

function ChartsPlaceholder({ children }: { children?: ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-2" aria-busy={!children}>
      {children ?? [0, 1, 2, 3].map((i) => <div key={i} className="panel h-[17rem]" />)}
    </div>
  );
}

export default function App() {
  const { snapshot, history, status, error } = useSystemStream();
  const providers = useProviders();
  const apiKey = useApiKey();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  const dimmed = (status === 'offline' || status === 'stale') && snapshot !== null;

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only rounded-lg bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Header snapshot={snapshot} status={status} onOpenSettings={openSettings} />

      <main id="main" className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 px-4 py-4">
        <ConnectionNotice status={status} error={error} lastCollectedAt={snapshot?.collected_at} />

        {/* While offline or stale, hold the last reading at reduced opacity rather than blanking it. */}
        <div className={`flex flex-col gap-3 transition-opacity ${dimmed ? 'opacity-70' : ''}`}>
          <KpiGrid snapshot={snapshot} />
          <ErrorBoundary
            fallback={
              <ChartsPlaceholder>
                <div className="panel md:col-span-2">
                  <EmptyState
                    icon={ChartLine}
                    title="Charts failed to load"
                    detail="Reload the page to try again."
                  />
                </div>
              </ChartsPlaceholder>
            }
          >
            <Suspense fallback={<ChartsPlaceholder />}>
              <SystemCharts history={history} windowMs={HISTORY_WINDOW_MS} />
            </Suspense>
          </ErrorBoundary>
          <div className="grid gap-3 lg:grid-cols-3">
            <CoreBars cpu={snapshot?.cpu} />
            <ThrottleStatus throttling={snapshot?.throttling} />
            <FilesystemTable filesystems={snapshot?.filesystems} />
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <ChatPanel
            className="lg:col-span-2"
            providers={providers.providers}
            apiKey={apiKey}
            onOpenSettings={openSettings}
          />
          <ProvidersPanel state={providers} />
        </div>
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
