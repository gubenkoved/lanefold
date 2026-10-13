import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEMO_REPO, E2E_DIR } from './paths';

/** What tests of earlier runs made is kept this long (see {@link sweep}). */
const KEEP_MS = 60 * 60_000;

/**
 * Builds the deterministic demo repository the e2e tests browse (once per run), after letting
 * go of what earlier runs made.
 */
export default function globalSetup(): void {
  if (!existsSync('out/harness/make-demo-repo.mjs')) {
    throw new Error('Run `npm run pretest:e2e` (builds the webview and the harness) first.');
  }
  sweep(E2E_DIR, KEEP_MS);
  execFileSync('node', ['out/harness/make-demo-repo.mjs', dirname(DEMO_REPO)], {
    stdio: 'inherit',
  });
}

/**
 * Removes the repositories tests made under `root` (in a folder of their own, under one per spec)
 * more than `keepMs` ago: a run makes thousands of folders, which would otherwise pile up run
 * after run. The latest ones stay, for a look at what a failed test left and for a run going on
 * at the same time; the demo is built afresh anyway.
 */
function sweep(root: string, keepMs: number): void {
  if (!existsSync(root)) return;
  const now = Date.now();
  for (const spec of readdirSync(root, { withFileTypes: true })) {
    if (!spec.isDirectory() || spec.name === 'demo') continue;
    const dir = join(root, spec.name);
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      try {
        if (now - statSync(path).mtimeMs > keepMs) remove(path);
      } catch {
        // Gone already, or it cannot be removed: left for the next run.
      }
    }
  }
}

/** Removes a folder, making writable first any folder in it a test left read-only. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    writable(path);
    rmSync(path, { recursive: true, force: true });
  }
}

function writable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) writable(join(dir, entry.name));
}
