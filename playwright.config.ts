import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.LANEFOLD_E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'test/e2e',
  // Performance budgets run separately (`npm run test:perf`): they build a large repository.
  testIgnore: ['**/perf.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './test/e2e/globalSetup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // A bottom-panel-like viewport.
    viewport: { width: 1280, height: 420 },
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    launchOptions: {
      // Use a preinstalled Chromium when provided (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium).
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
  },
  webServer: {
    command: `node out/harness/server.mjs --port ${PORT}`,
    // Commits need an identity, which a machine without a domain name cannot make up.
    env: {
      GIT_AUTHOR_NAME: 'Lanefold E2E',
      GIT_AUTHOR_EMAIL: 'e2e@lanefold.test',
      GIT_COMMITTER_NAME: 'Lanefold E2E',
      GIT_COMMITTER_EMAIL: 'e2e@lanefold.test',
    },
    url: `http://127.0.0.1:${PORT}/themes`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
