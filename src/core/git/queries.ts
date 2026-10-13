/** Small read-only questions to git that many parts of Lanefold ask. */

import type { Repository } from '../repo/repository';
import { revisions } from './args';

/** The commit a revision names, or undefined when it names none. */
export async function resolveCommit(repo: Repository, rev: string): Promise<string | undefined> {
  const result = await repo.git(['rev-parse', '-q', '--verify', ...revisions(`${rev}^{commit}`)], {
    readOnly: true,
    background: true,
    label: 'Resolve a commit',
    okExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** Whether `ancestor` is in the history of `descendant` (false when either is not a commit). */
export async function isAncestor(repo: Repository, ancestor: string, descendant: string): Promise<boolean> {
  const result = await repo.git(['merge-base', '--is-ancestor', ...revisions(ancestor, descendant)], {
    readOnly: true,
    background: true,
    label: 'Check ancestry',
    okExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0;
}

/** How many commits `git rev-list` lists for these arguments. */
export async function count(repo: Repository, args: string[]): Promise<number> {
  const { stdout } = await repo.git(['rev-list', '--count', ...args], {
    readOnly: true,
    background: true,
    label: 'Count commits',
  });
  return Number(stdout.trim()) || 0;
}

/** The names of the remotes. */
export async function remoteNames(repo: Repository): Promise<string[]> {
  const { stdout } = await repo.git(['remote'], { readOnly: true, background: true, label: 'Remotes' });
  return stdout.split('\n').filter(Boolean);
}
