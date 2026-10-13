import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores([
    'dist/',
    'out/',
    'coverage/',
    '.vscode-test/',
    'test-results/',
    'playwright-report/',
    'node_modules/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/webview/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/core/**', 'src/extension/**', 'src/shared/**', 'test/**', 'dev/**', '*.mjs', '*.mts'],
    languageOptions: { globals: globals.node },
  },
  // Helper scripts git runs directly are plain CommonJS.
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // Module boundaries: shared code is pure (runs in Node, the webview and web workers),
  // core is Node-only and never touches the VS Code API, the webview never touches either.
  {
    files: ['src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'vscode'], message: 'src/shared must stay environment-agnostic.' },
            {
              group: ['**/core/**', '**/extension/**', '**/webview/**'],
              message: 'src/shared must not depend on other layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode'],
              message: 'src/core must not use the VS Code API (it also runs in the dev harness).',
            },
            {
              group: ['**/extension/**', '**/webview/**'],
              message: 'src/core must not depend on the extension or webview layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/webview/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'vscode'], message: 'The webview runs in a browser sandbox.' },
            {
              group: ['**/core/**', '**/extension/**'],
              message: 'The webview talks to the host only through RPC.',
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
