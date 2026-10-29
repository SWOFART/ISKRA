import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8789', browserName: 'chromium', trace: 'off' },
  webServer: {
    command: 'npm run dev -- --local --ip 127.0.0.1 --port 8789 --var FIREBASE_PROJECT_ID:iskra-browser-test',
    env: {
      VITE_FIREBASE_API_KEY: 'local-browser-fixture-key',
      VITE_FIREBASE_PROJECT_ID: 'iskra-browser-test',
      VITE_FIREBASE_AUTH_DOMAIN: 'iskra-browser-test.firebaseapp.com',
      VITE_FIREBASE_APP_ID: 'local-browser-fixture-app',
      VITE_MAPTILER_KEY: 'local-map-fixture-key',
    },
    url: 'http://127.0.0.1:8789/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
