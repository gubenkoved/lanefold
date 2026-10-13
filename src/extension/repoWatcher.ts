import * as vscode from 'vscode';
import { classifyGitDirChange } from '../core/repo/changes';
import type { Repository } from '../core/repo/repository';
import { debounceCollect } from '../core/util/emitter';
import { paths } from '../core/util/paths';
import type { RepoChangeKind } from '../shared/models';

/**
 * Files in the per-worktree git dir that signal a change worth refreshing for; in submodules' own
 * git dirs (modules/), what a commit or checkout there moves.
 */
const GIT_DIR_GLOB =
  '{HEAD,index,ORIG_HEAD,FETCH_HEAD,MERGE_HEAD,MERGE_MSG,CHERRY_PICK_HEAD,REVERT_HEAD,REBASE_HEAD,AUTO_MERGE,' +
  'BISECT_LOG,BISECT_START,packed-refs,config,refs/**,rebase-merge/**,rebase-apply/**,sequencer/**,reftable/**,logs/refs/stash,' +
  'modules/**/HEAD,modules/**/packed-refs,modules/**/refs/heads/**}';

/** Shared files that live in the common dir of linked worktrees. */
const COMMON_DIR_GLOB = '{packed-refs,config,refs/**,reftable/**,logs/refs/stash}';

/**
 * Watches a repository's git dir(s) and working tree, classifies changes and reports them in
 * debounced batches. Working-tree edits are batched more slowly than ref changes.
 */
export function watchRepository(
  repo: Repository,
  onChange: (kinds: ReadonlySet<RepoChangeKind>) => void,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const gitChanges = debounceCollect<RepoChangeKind>(100, (kinds) => onChange(kinds));
  const worktreeChanges = debounceCollect<RepoChangeKind>(400, (kinds) => onChange(kinds));
  disposables.push(gitChanges, worktreeChanges);

  const watchGitDir = (base: string, glob: string) => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(base), glob),
    );
    const handle = (uri: vscode.Uri) => {
      const inside = paths.relativeInside(base, uri.fsPath);
      const kind = inside === undefined ? undefined : classifyGitDirChange(inside);
      if (kind) gitChanges(kind);
    };
    disposables.push(
      watcher,
      watcher.onDidCreate(handle),
      watcher.onDidChange(handle),
      watcher.onDidDelete(handle),
    );
  };

  watchGitDir(repo.gitDir, GIT_DIR_GLOB);
  if (!paths.same(repo.commonDir, repo.gitDir)) watchGitDir(repo.commonDir, COMMON_DIR_GLOB);

  const worktree = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(repo.root), '**/*'),
  );
  const handleWorktree = (uri: vscode.Uri) => {
    if (paths.relativeInside(repo.gitDir, uri.fsPath) !== undefined) return;
    worktreeChanges('worktree');
  };
  disposables.push(
    worktree,
    worktree.onDidCreate(handleWorktree),
    worktree.onDidChange(handleWorktree),
    worktree.onDidDelete(handleWorktree),
  );

  return vscode.Disposable.from(...disposables);
}
