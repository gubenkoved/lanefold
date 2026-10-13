// Bundles the extension host side of Lanefold (extension, log worker, git helper scripts)
// and, with --harness, the browser dev harness server.
import * as esbuild from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const harness = args.has('--harness');

/** Entries that run inside the VS Code extension host (or are spawned by git from it). */
const extensionEntries = [
  { in: 'src/extension/extension.ts', out: 'extension' },
  { in: 'src/core/log/logWorker.ts', out: 'logWorker' },
  { in: 'src/core/rebase/sequence-editor.cjs', out: 'scripts/sequence-editor' },
  { in: 'src/core/ipc/askpass-main.cjs', out: 'scripts/askpass-main' },
];

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  // Notices of bundled code go to a .LEGAL.txt file next to the bundle.
  legalComments: 'linked',
};

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  ...common,
  entryPoints: extensionEntries,
  outdir: 'dist',
  external: ['vscode'],
};

/** @type {esbuild.BuildOptions} */
const harnessOptions = {
  ...common,
  entryPoints: [
    { in: 'dev/harness/server.ts', out: 'server' },
    { in: 'dev/demo/makeDemoRepo.ts', out: 'make-demo-repo' },
    { in: 'src/core/log/logWorker.ts', out: 'logWorker' },
  ],
  outdir: 'out/harness',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  // The harness runs from the repository, so dependencies resolve from node_modules at runtime.
  packages: 'external',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

/** VS Code integration test suites (run by @vscode/test-cli inside VS Code). */
/** @type {esbuild.BuildOptions} */
const testOptions = {
  ...common,
  entryPoints: ['test/vscode/*.test.ts'],
  outdir: 'out/test/vscode',
  external: ['vscode', 'mocha'],
  sourcemap: 'inline',
};

const options = args.has('--tests') ? testOptions : harness ? harnessOptions : extensionOptions;

/** Shell wrappers git runs directly are copied as they are (and kept executable). */
function copyScripts() {
  if (options !== extensionOptions) return;
  mkdirSync('dist/scripts', { recursive: true });
  copyFileSync('src/core/ipc/askpass.sh', 'dist/scripts/askpass.sh');
  chmodSync('dist/scripts/askpass.sh', 0o755);
}

if (watch) {
  copyScripts();
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  copyScripts();
}
