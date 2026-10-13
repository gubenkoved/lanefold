import type { RepoChangeKind } from '../../shared/models';

/**
 * Classifies a changed path inside a git directory (relative, forward slashes) into the kind of
 * repository change it signals, or `undefined` when it can be ignored (objects, logs, locks, ...).
 */
export function classifyGitDirChange(relativePath: string): RepoChangeKind | undefined {
  const path = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (path.length === 0 || path.endsWith('.lock')) return undefined;
  const [first] = path.split('/', 1) as [string];

  switch (first) {
    case 'HEAD':
      return 'head';
    case 'index':
      return 'index';
    case 'refs':
      return path === 'refs/stash' ? 'stash' : 'refs';
    case 'packed-refs':
    case 'reftable':
    case 'ORIG_HEAD':
    case 'FETCH_HEAD':
      return 'refs';
    case 'MERGE_HEAD':
    case 'MERGE_MSG':
    case 'CHERRY_PICK_HEAD':
    case 'REVERT_HEAD':
    case 'REBASE_HEAD':
    case 'AUTO_MERGE':
    case 'rebase-merge':
    case 'rebase-apply':
    case 'sequencer':
    case 'BISECT_LOG':
    case 'BISECT_START':
    case 'BISECT_TERMS':
      return 'opState';
    case 'config':
      return 'config';
    case 'logs':
      // The stash list lives in the stash reflog.
      return path === 'logs/refs/stash' ? 'stash' : undefined;
    case 'modules':
      // A submodule's own git dir: a commit or checkout there changes what this repository's
      // status says about the submodule (its folder's files may not change at all).
      return /\/(?:HEAD|packed-refs|refs\/heads\/.+)$/.test(path) ? 'worktree' : undefined;
    default:
      return undefined;
  }
}
