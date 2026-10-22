import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor default to 1 s, which a cold first run on a busy CI runner can exceed.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  // Pure-logic suites run in the node environment, where there is no DOM.
  if (typeof window === 'undefined') return;
  cleanup();
  window.localStorage.clear();
});
