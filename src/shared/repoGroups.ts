import type { RepoSummary } from './models';

/**
 * A comparable form of a git directory: forward slashes, no trailing slash, and (Windows paths)
 * no regard to case, since git and the editor may spell a drive differently.
 */
export function storeKey(commonDir: string): string {
  const path = commonDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(path) ? path.toLowerCase() : path;
}

/**
 * Repositories grouped by object store: the linked worktrees of a repository share its objects
 * and refs (its common git directory), so a log of several repositories reads each store once.
 * Groups, and the repositories in them, keep the order of `repos`.
 */
export function objectStores<T extends Pick<RepoSummary, 'commonDir'>>(repos: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const repo of repos) {
    const key = storeKey(repo.commonDir);
    const group = groups.get(key);
    if (group) group.push(repo);
    else groups.set(key, [repo]);
  }
  return [...groups.values()];
}
