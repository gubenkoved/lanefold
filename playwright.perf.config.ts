import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Performance budgets on a large synthetic repository (see test/e2e/perf.spec.ts). */
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['**/perf.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
});
