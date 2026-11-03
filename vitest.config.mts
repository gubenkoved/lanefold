import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Tests of webview code that needs the browser's types live in test/webview (typechecked apart).
          include: ['test/unit/**/*.test.ts', 'test/webview/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'git',
          include: ['test/git/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
