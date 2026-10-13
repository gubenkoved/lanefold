import type * as vscode from 'vscode';
import { diffWithContents } from '../core/blame/blame';
import { filePaths } from '../core/git/args';
import type { RepositoryRegistry } from '../core/repo/registry';
import type { Repository } from '../core/repo/repository';
import { paths } from '../core/util/paths';
import { mapLineToOld, parseHunks } from '../shared/blame';
import { parseRevisionUri } from './revisionFs';

/** A file (or folder) in one of the open repositories; `rev` for Lanefold revision documents. */
export interface FileLocation {
  readonly repo: Repository;
  /** Relative to the repository root, forward slashes ('' is the root itself). */
  readonly path: string;
  readonly rev?: string;
}

export function locateFile(registry: RepositoryRegistry, uri: vscode.Uri): FileLocation | undefined {
  const revision = parseRevisionUri(uri);
  if (revision) {
    const repo = registry.get(revision.repo);
    return repo ? { repo, path: revision.path, rev: revision.rev } : undefined;
  }
  if (uri.scheme !== 'file') return undefined;
  // The innermost repository wins (nested repositories, submodules).
  let best: FileLocation | undefined;
  for (const repo of registry.all) {
    const inside = paths.relativeInside(repo.root, uri.fsPath);
    if (inside !== undefined && (!best || repo.root.length > best.repo.root.length))
      best = { repo, path: inside };
  }
  return best;
}

/**
 * Lines `start`–`end` of the file (on disk, or the editor's unsaved `contents`), as lines of
 * HEAD's version (`git log -L` looks the lines up there): uncommitted edits above them shift them.
 */
export async function linesAtHead(
  repo: Repository,
  file: string,
  start: number,
  end: number,
  contents?: string,
): Promise<{ start: number; end: number }> {
  const { stdout } =
    contents !== undefined
      ? { stdout: await diffWithContents(repo, `HEAD:${file}`, contents) }
      : await repo.git(
          ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', ...filePaths(file)],
          { readOnly: true, background: true, label: 'Line history' },
        );
  const hunks = parseHunks(stdout);
  const a = mapLineToOld(hunks, start);
  const b = mapLineToOld(hunks, end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
