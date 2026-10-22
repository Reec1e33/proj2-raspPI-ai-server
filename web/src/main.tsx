import { OctagonAlert } from 'lucide-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { EmptyState } from './components/Panel';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element in index.html');

// Last resort: an unexpected render error shows a message instead of a blank page.
const crashed = (
  <main className="grid min-h-dvh place-items-center p-4">
    <div className="panel">
      <EmptyState
        icon={OctagonAlert}
        title="The dashboard stopped with an error"
        detail="Reload the page to try again."
      />
    </div>
  </main>
);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary fallback={crashed}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
