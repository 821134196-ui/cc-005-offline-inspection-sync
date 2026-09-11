import { defineConfig } from '@playwright/test';

// The Go backend must already be running (docker compose, or locally).
// BACKEND_URL points at it; the built PWA is served/proxied by serve.mjs.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8090',
    actionTimeout: 10_000
  },
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:8090',
    reuseExistingServer: true,
    timeout: 20_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
