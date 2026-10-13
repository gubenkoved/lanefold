import { realpath } from 'node:fs/promises';
import type { WorktreeInfo } from '../../shared/models';
import { paths } from '../util/paths';
import type { Repository } from './repository';

/**
 * Parses `git worktree list --porcelain -z` (records end with an empty field). The worktree at
 * one of `currentRoots` (the root as opened, and its real path) is the current one.
 */
export function parseWorktrees(stdout: string, ...currentRoots: string[]): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let record: Record<string, string> = {};
  const flush = () => {
    if (record.worktree !== undefined) {
      const path = record.worktree;
      worktrees.push({
        path,
        head: record.HEAD,
        branch: record.branch?.replace(/^refs\/heads\//, ''),
        bare: 'bare' in record,
        locked: 'locked' in record ? record.locked || 'locked' : undefined,
        prunable: 'prunable' in record ? record.prunable || 'its folder is gone' : undefined,
        main: worktrees.length === 0,
        current: currentRoots.some((root) => paths.same(path, root)),
      });
    }
    record = {};
  };
  for (const field of stdout.split('\0')) {
    if (field === '') {
      flush();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    record[key] = space < 0 ? '' : field.slice(space + 1);
  }
  flush();
  return worktrees;
}

export async function readWorktrees(repo: Repository): Promise<WorktreeInfo[]> {
  const list = (z: boolean) =>
    repo.git(['worktree', 'list', '--porcelain', ...(z ? ['-z'] : [])], {
      readOnly: true,
      background: true,
      label: 'Worktrees',
      okExitCodes: [0, 129],
    });
  let result = await list(true);
  // git before 2.36 has no -z: the same records, one field per line.
  if (result.exitCode === 129) {
    result = await list(false);
    if (result.exitCode !== 0) return [];
    result = { ...result, stdout: result.stdout.replace(/\n/g, '\0') };
  }
  // git lists real paths; the root may have been opened through a symbolic link.
  const real = await realpath(repo.root).catch(() => repo.root);
  const trees = parseWorktrees(result.stdout, repo.root, real);
  // A submodule's repository lives in its superproject's .git/modules, and git names that folder
  // as the main worktree: opened in its main worktree, that worktree is this one.
  const main = trees[0];
  if (main && !main.current && paths.same(repo.gitDir, repo.commonDir)) {
    const common = await realpath(repo.commonDir).catch(() => repo.commonDir);
    if (paths.same(main.path, repo.commonDir) || paths.same(main.path, common))
      trees[0] = { ...main, path: repo.root, current: true };
  }
  return trees;
}
