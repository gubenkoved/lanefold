import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../core/repo/repository';
import type { DiffSide } from '../shared/models';
import { displayRev } from '../shared/oid';

export const REVISION_SCHEME = 'lanefold';

/** Sentinel revision for "this side has no file" (added/deleted files). */
export const EMPTY_REVISION = 'EMPTY';

const IMMUTABLE_REV = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|EMPTY)$/;

export interface RevisionQuery {
  readonly repo: string;
  readonly rev: string;
  /** Path relative to the repository root, with forward slashes. */
  readonly path: string;
  /** Short label of the revision for editor titles ("1a2b3c4d", "Index"). */
  readonly ref?: string;
}

/** Conflict stages in the index: the merge base, the current side and the incoming side. */
const STAGES: Record<string, string> = { ':1': 'Base', ':2': 'Current', ':3': 'Incoming' };

function refLabel(rev: string): string {
  if (rev === 'INDEX') return 'Index';
  if (STAGES[rev]) return STAGES[rev];
  if (rev === EMPTY_REVISION) return 'empty';
  return displayRev(rev);
}

/**
 * URI for a file at a revision. The URI path is the file's absolute path (so editors pick the
 * right language and show the right name); the query carries the repository and revision.
 */
export function revisionUri(repo: Repository, side: DiffSide): vscode.Uri {
  if (side.rev === 'WORKTREE') return vscode.Uri.file(path.join(repo.root, side.path));
  const query: RevisionQuery = { repo: repo.root, rev: side.rev, path: side.path, ref: refLabel(side.rev) };
  return vscode.Uri.file(path.join(repo.root, side.path)).with({
    scheme: REVISION_SCHEME,
    query: JSON.stringify(query),
  });
}

export function emptyUri(repo: Repository, filePath: string): vscode.Uri {
  return revisionUri(repo, { path: filePath, rev: EMPTY_REVISION });
}

/** The repository, revision and path of a `lanefold:` URI (undefined for anything else). */
export function parseRevisionUri(uri: vscode.Uri): RevisionQuery | undefined {
  if (uri.scheme !== REVISION_SCHEME) return undefined;
  try {
    const query = JSON.parse(uri.query) as Partial<RevisionQuery>;
    if (typeof query.repo === 'string' && typeof query.rev === 'string' && typeof query.path === 'string') {
      return query as RevisionQuery;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function parseQuery(uri: vscode.Uri): RevisionQuery {
  const query = parseRevisionUri(uri);
  if (!query) throw vscode.FileSystemError.FileNotFound(uri);
  return query;
}

/** Contents larger than this are not kept in memory between reads. */
const MAX_CACHED_FILE = 4 * 1024 * 1024;
const MAX_CACHED_TOTAL = 48 * 1024 * 1024;

/**
 * Read-only file system serving file contents at any revision (`git cat-file blob <rev>:<path>`).
 * Works for text and binary files alike, so image diffs render in VS Code's image preview.
 *
 * Object IDs never change. The index, HEAD and branch names do: when their repository changes,
 * open documents for them are told to reload (a new `mtime` makes editors re-read them).
 */
export class RevisionFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  /** Contents by URI and repository version (a change makes older versions unreachable). */
  private readonly cache = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Watched documents whose revision moves, with how many watchers each has. */
  private readonly watched = new Map<string, { uri: vscode.Uri; repo: string; count: number }>();
  /** Per repository: when it last changed, the `mtime` of its moving revisions. */
  private readonly versions = new Map<string, number>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly repoOf: (root: string) => Repository | undefined,
    onDidChangeRepo: (listener: (repoId: string) => void) => vscode.Disposable,
  ) {
    this.subscription = onDidChangeRepo((repoId) => this.repoChanged(repoId));
  }

  static register(
    repoOf: (root: string) => Repository | undefined,
    onDidChangeRepo: (listener: (repoId: string) => void) => vscode.Disposable,
  ): vscode.Disposable {
    const provider = new RevisionFileSystem(repoOf, onDidChangeRepo);
    return vscode.Disposable.from(
      provider,
      vscode.workspace.registerFileSystemProvider(REVISION_SCHEME, provider, {
        isCaseSensitive: true,
        isReadonly: true,
      }),
    );
  }

  private repoChanged(repoId: string): void {
    this.versions.set(repoId, Math.max(Date.now(), (this.versions.get(repoId) ?? 0) + 1));
    const changed = [...this.watched.values()].filter((entry) => entry.repo === repoId);
    if (changed.length > 0)
      this.emitter.fire(changed.map(({ uri }) => ({ type: vscode.FileChangeType.Changed, uri })));
  }

  /** Changes with the repository (0 for object IDs, which never change). */
  private version(query: RevisionQuery): number {
    return IMMUTABLE_REV.test(query.rev) ? 0 : (this.versions.get(query.repo) ?? 1);
  }

  /** The repository and `git cat-file` argument for a URI (undefined: the empty side). */
  private target(uri: vscode.Uri): { repo: Repository; spec: string } | undefined {
    const query = parseQuery(uri);
    if (query.rev === EMPTY_REVISION) return undefined;
    // A revision is never an option (the spec below is git's first non-option argument).
    if (query.rev.startsWith('-') || query.path.startsWith('-'))
      throw vscode.FileSystemError.FileNotFound(uri);
    const repo = this.repoOf(query.repo);
    if (!repo) throw vscode.FileSystemError.Unavailable(`Repository ${query.repo} is not open`);
    // "INDEX" is the staged version (stage 0); a conflict's stages (":1"–":3") and tree-ishes
    // read as `<rev>:<path>` alike.
    if (query.rev === 'INDEX') return { repo, spec: `:0:${query.path}` };
    return { repo, spec: `${query.rev}:${query.path}` };
  }

  private async read(uri: vscode.Uri): Promise<Uint8Array> {
    const key = `${uri.toString()}#${this.version(parseQuery(uri))}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const target = this.target(uri);
    let content: Uint8Array = new Uint8Array(0);
    if (target) {
      const result = await target.repo.runner.runBuffer({
        cwd: target.repo.root,
        args: ['cat-file', 'blob', target.spec],
        readOnly: true,
        background: true,
        label: 'Read file at revision',
        okExitCodes: [0, 128],
      });
      if (result.exitCode !== 0) throw vscode.FileSystemError.FileNotFound(uri);
      content = result.stdout;
    }
    if (content.length <= MAX_CACHED_FILE) {
      this.cache.set(key, content);
      this.cachedBytes += content.length;
      while (this.cache.size > 200 || this.cachedBytes > MAX_CACHED_TOTAL) {
        const [oldest, bytes] = this.cache.entries().next().value as [string, Uint8Array];
        this.cache.delete(oldest);
        this.cachedBytes -= bytes.length;
      }
    }
    return content;
  }

  /** The size without reading the content (`cat-file -s`), unless it is at hand. */
  private async size(uri: vscode.Uri): Promise<number> {
    const cached = this.cache.get(`${uri.toString()}#${this.version(parseQuery(uri))}`);
    if (cached) return cached.length;
    const target = this.target(uri);
    if (!target) return 0;
    const result = await target.repo.git(['cat-file', '-s', target.spec], {
      readOnly: true,
      background: true,
      label: 'Read file size at revision',
      okExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) throw vscode.FileSystemError.FileNotFound(uri);
    return Number(result.stdout.trim()) || 0;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.version(parseQuery(uri)),
      size: await this.size(uri),
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.read(uri);
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const query = parseRevisionUri(uri);
    if (!query || IMMUTABLE_REV.test(query.rev)) return new vscode.Disposable(() => undefined);
    const key = uri.toString();
    const entry = this.watched.get(key) ?? { uri, repo: query.repo, count: 0 };
    entry.count += 1;
    this.watched.set(key, entry);
    return new vscode.Disposable(() => {
      entry.count -= 1;
      if (entry.count <= 0) this.watched.delete(key);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
    this.cache.clear();
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
  }
}
