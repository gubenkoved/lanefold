import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';
import { DEMO_REPO, fixtureDir } from './paths';

/*
 * What the e2e specs share: git for fixtures and checks, private copies of the demo repository,
 * the graph's rows, the history editor, and what the harness recorded of a session.
 */

/**
 * Runs git in `repo` (a folder; `-C`) and returns its output, trimmed. Commits are by
 * "Test <test@example.com>" (`-c user.name=…` among the arguments names someone else); no
 * editor opens (git keeps the message it offers); submodules may be cloned from local folders,
 * which git refuses by default (the tests' own commands allow it, never the app's). A failing
 * command throws with git's messages.
 */
export function git(repo: string, ...args: string[]): string {
  return gitRaw(repo, ...args).trim();
}

/** {@link git}, its output untrimmed (to compare file contents exactly). */
export function gitRaw(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'protocol.file.allow=always',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } },
  );
}

/** The subjects of `repo`'s last `count` commits, newest first. */
export function subjects(repo: string, count: number): string[] {
  return git(repo, 'log', `-${count}`, '--format=%s').split('\n');
}

/**
 * A private copy of the demo repository for a test that changes it: `aurora`, in a folder of its
 * own under the spec's (see fixtureDir) (other fixtures can go next to it). The demo has uncommitted changes,
 * NOTES.md staged and src/dashboard.css modified; `stash` sets them aside first, so the copy
 * starts clean (`git stash`; 'including untracked' adds `--include-untracked`, and the stash
 * then has a commit of untracked files, empty here).
 */
export function copyDemo(options: { stash?: true | 'including untracked' } = {}): string {
  const dir = fixtureDir(basename(test.info().file, '.spec.ts'));
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, 'aurora');
  cpSync(DEMO_REPO, repo, { recursive: true });
  if (options.stash === true) git(repo, 'stash', '-q');
  else if (options.stash) git(repo, 'stash', 'push', '-q', '--include-untracked');
  return repo;
}

/** The graph's rows in the visible tab (kept-alive tabs are hidden; ghosts and spare rows excluded). */
export function graphRows(page: Page): Locator {
  return page.getByRole('tabpanel').locator('[role="grid"] [role="rowgroup"] > [role="row"]:not([hidden])');
}

/** The first graph row with `text`: a commit's subject, “Uncommitted changes”, a branch… */
export function graphRow(page: Page, text: string | RegExp): Locator {
  return graphRows(page).filter({ hasText: text }).first();
}

/** The history editor, editing main. */
export function historyEditor(page: Page): Locator {
  return page.getByRole('region', { name: /Edit history of main/ });
}

/**
 * A commit in the history editor's list, by its subject. Its name starts with its action
 * (“Squash: Improve README · …”) and can mention other commits (“folds into “…””): matched from
 * the action, only the commit itself matches.
 */
export function planRow(page: Page, subject: string): Locator {
  return historyEditor(page).getByRole('option', { name: new RegExp(`^[A-Za-z]+: ${subject}`) });
}

/**
 * A harness debug endpoint, `/debug/<what>`, for the page's session (the repositories and session
 * of its URL), with more `params` when the endpoint takes some.
 */
export function debugUrl(page: Page, what: string, params: Record<string, string> = {}): string {
  const url = new URL(page.url());
  const query = new URLSearchParams();
  for (const repo of url.searchParams.getAll('repo')) query.append('repo', repo);
  query.set('session', url.searchParams.get('session') ?? '');
  for (const [name, value] of Object.entries(params)) query.set(name, value);
  return `/debug/${what}?${query.toString()}`;
}

/** A diff the app asked the editor to open (the harness keeps them for the tests). */
export interface OpenedDiff {
  readonly title: string;
  readonly repo?: string;
  readonly left?: string;
  readonly right?: string;
  readonly base?: string;
  readonly target?: string;
  readonly files?: readonly string[];
}

/** The diffs the page's session asked the editor to open so far. */
export async function openedDiffs(page: Page): Promise<OpenedDiff[]> {
  const response = await page.request.get(debugUrl(page, 'diffs'));
  if (!response.ok()) throw new Error(`${response.url()}: ${response.status()} ${await response.text()}`);
  return (await response.json()) as OpenedDiff[];
}
