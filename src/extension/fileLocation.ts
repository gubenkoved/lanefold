import type * as vscode from 'vscode';
import type { RepositoryRegistry } from '../core/repo/registry';
import type { Repository } from '../core/repo/repository';
import { paths } from '../core/util/paths';
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
