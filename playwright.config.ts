import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8789', browserName: 'chromium', trace: 'off' },
  webServer: {
    command: 'npm run dev -- --local --ip 127.0.0.1 --port 8789',
    url: 'http://127.0.0.1:8789/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
