import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // VITE_API_PROXY may come from the shell or a local .env file; it only
  // configures the dev/preview proxy and is never referenced by app code.
  const env = loadEnv(mode, process.cwd(), '');
  // `||`, not `??`: an empty `VITE_API_PROXY=` line must also fall back to the default.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const apiTarget = env.VITE_API_PROXY || 'http://localhost:8000';

  // http-proxy streams responses unbuffered, so /api/system/stream (SSE) and
  // streamed /api/chat responses pass through as they are produced.
  const proxy = { '/api': { target: apiTarget, changeOrigin: true } };

  return {
    plugins: [react(), tailwindcss()],
    base: '/',
    server: { proxy },
    preview: { proxy },
    build: { outDir: 'dist' },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      unstubGlobals: true,
      css: false,
    },
  };
});
