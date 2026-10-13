import type { ChangedFile } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import type { HostRpc } from '../../bridge/host';
import { toast } from '../../components/Toast';
import { revLabel } from '../../state/tabs';
import { showSubmoduleCommits } from './submodules';

/** Display name of a diff side ("abc12345", "Working Tree", "Index"). */
export function sideLabel(rev: string | undefined): string {
  if (rev === undefined) return 'empty';
  if (rev === 'WORKTREE') return 'Working Tree';
  if (rev === 'INDEX') return 'Index';
  return revLabel(rev);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function report(error: unknown): void {
  toast('Could not open the diff', {
    kind: 'error',
    detail: errorText(error),
  });
}

/**
 * Opens one file's changes from `base` to `target` in the native diff editor. `base`
 * undefined means the file did not exist before (root commits, untracked files).
 */
export function openFileDiff(
  rpc: HostRpc,
  repoId: string,
  file: ChangedFile,
  base: string | undefined,
  target: string,
): void {
  // A submodule records a commit, not contents: what changed is its commits, in its repository.
  if (file.submodule) {
    void showSubmoduleCommits(repoId, file.path, file.submodule, file.oldPath);
    return;
  }
  const title = `${basename(file.path)} (${sideLabel(base)} ↔ ${sideLabel(target)})`;
  const left =
    file.status === 'A' || base === undefined ? undefined : { path: file.oldPath ?? file.path, rev: base };
  const right = file.status === 'D' ? undefined : { path: file.path, rev: target };
  rpc.call('diff.open', { repoId, title, left, right }).catch(report);
}

/** Opens every file's changes in VS Code's multi-file diff editor. */
export function openAllDiffs(
  rpc: HostRpc,
  repoId: string,
  title: string,
  files: readonly ChangedFile[],
  base: string | undefined,
  target: string,
): void {
  if (files.length === 0) return;
  // Submodules have no contents to compare here (each opens in its own repository).
  const contents = files.filter((file) => !file.submodule);
  if (contents.length === 0) {
    toast('Only submodules changed', { detail: 'Open one to see its commits.' });
    return;
  }
  rpc.call('diff.openAll', { repoId, title, files: contents, base, target }).catch(report);
}
