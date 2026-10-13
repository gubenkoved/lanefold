import { defineConfig } from '@vscode/test-cli';

const launchArgs = [
  '--disable-extensions',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-workspace-trust',
  '--disable-gpu',
];
// Electron refuses to start as root without disabling the sandbox (CI containers).
if (process.getuid?.() === 0) launchArgs.push('--no-sandbox');

// The test workspace is the demo repository, created by `npm run pretest:vscode`.
export default defineConfig({
  label: 'integration',
  files: 'out/test/vscode/**/*.test.js',
  version: process.env.LANEFOLD_VSCODE_VERSION ?? 'stable',
  workspaceFolder: './out/test/vscode-workspace/aurora',
  launchArgs,
  mocha: {
    ui: 'tdd',
    timeout: 60_000,
  },
});
