import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the e2e tests make their repositories: outside the project, so that an editor with it
 * open does not watch the thousands of folders a run makes (file watches are a per-user budget,
 * and the harness needs its share). `LANEFOLD_E2E_DIR` puts them elsewhere.
 */
export const E2E_DIR = process.env.LANEFOLD_E2E_DIR ?? join(tmpdir(), 'lanefold-e2e');

/** A new folder for a test's repositories, under its spec's (`fixtureDir('split')`). */
export function fixtureDir(spec: string): string {
  return join(E2E_DIR, spec, randomUUID());
}

/** Where globalSetup builds the demo repository. */
export const DEMO_REPO = join(E2E_DIR, 'demo', 'aurora');

/** The demo repository's remote (its origin), built next to it. */
export const DEMO_REMOTE = join(E2E_DIR, 'demo', 'aurora-remote.git');

/**
 * Harness URL for a repository and theme. Each call gets its own backend session so tests that
 * run in parallel never share persisted UI state (tabs, layout).
 */
export function harnessUrl(options: { repo?: string; theme?: string; session?: string } = {}): string {
  const params = new URLSearchParams({
    repo: options.repo ?? DEMO_REPO,
    theme: options.theme ?? 'dark-modern',
    session: options.session ?? randomUUID(),
  });
  return `/?${params.toString()}`;
}
