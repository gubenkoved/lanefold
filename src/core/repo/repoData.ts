import type {
  ChangedFile,
  CommitDetails,
  CommitMeta,
  CompareSummary,
  HeadInfo,
  RefsSnapshot,
  RemoteInfo,
  SearchQuery,
  SearchResult,
  StashDetails,
  StashEntry,
  ViewConfig,
  WorkingTreeSummary,
  WorktreeChanges,
} from '../../shared/models';
import { filePaths, revisions } from '../git/args';
import { CatFileReader } from '../git/catFile';
import { searchArgs } from '../log/revList';
import { bodyOf, parseCommit, subjectOf, type RawCommit } from '../parsers/commit';
import { parseRawNumstat } from '../parsers/diff';
import {
  composeRefRecords,
  parseRefObject,
  parseRefRecords,
  pickTrunk,
  REFS_FAST_FORMAT,
  REFS_FORMAT,
  REFS_PATTERNS,
  splitRefRecords,
  type RefObject,
} from '../parsers/refs';
import { parseStatus, summarizeStatus, type StatusResult } from '../parsers/status';
import { readRemotes } from './remotes';
import type { Repository } from './repository';
import { readStashList } from './stash';
import { completeSubmoduleChanges, withCheckedOutCommits } from './submodules';

/** The empty tree, used as the "before" side of root commits. */
export function emptyTree(objectFormat: 'sha1' | 'sha256'): string {
  return objectFormat === 'sha256'
    ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

/**
 * Flags for every diff Lanefold parses: never run user diff drivers or textconv filters; full
 * object names (a submodule's commits).
 */
const DIFF_FLAGS = ['-z', '--raw', '--numstat', '-M', '--no-ext-diff', '--no-textconv', '--no-abbrev'];

const META_CACHE_SIZE = 20_000;

/** Objects remembered for reading refs (a tag-heavy repository has tens of thousands). */
const REF_OBJECTS_LIMIT = 200_000;
/** Up to this many new ref objects are read one by one; more, and one full pass is quicker. */
const REF_OBJECTS_READ_MAX = 300;

/** Read-side queries for one repository (refs, status, commit metadata, diffs). */
export class RepoData {
  private reader: CatFileReader | undefined;
  private readonly metaCache = new Map<string, CommitMeta>();
  /** Type, peeled object and date of the objects refs point to (immutable per object ID). */
  private readonly refObjects = new Map<string, RefObject>();
  /** A full read of every ref's object in progress: reads starting meanwhile wait, then go fast. */
  private fullRefRead: Promise<unknown> | undefined;
  /** Bumped when the repository is reported changed: reads started before are not fresh. */
  private epoch = 0;
  /** Reads in progress that views may share (see {@link status}). */
  private readonly sharedReads = new Map<
    string,
    { readonly epoch: number; readonly result: Promise<unknown> }
  >();

  constructor(readonly repo: Repository) {}

  private catFile(): CatFileReader {
    this.reader ??= new CatFileReader(this.repo.runner, this.repo.root, {
      mailmap: this.repo.runner.features.catFileMailmap,
    });
    return this.reader;
  }

  /** Prepares the object reader so the first metadata request does not wait for a spawn. */
  warmUp(): void {
    try {
      this.catFile().warmUp();
    } catch {
      // The first read will report the problem.
    }
  }

  /** Every ref, HEAD and the trunk; `shared` as for {@link status}. */
  refs(read: { shared?: boolean } = {}): Promise<RefsSnapshot> {
    return read.shared ? this.shared('refs', () => this.readRefs()) : this.readRefs();
  }

  /** The branch checked out and its commit; `shared` as for {@link status}. */
  head(read: { shared?: boolean } = {}): Promise<HeadInfo> {
    return read.shared ? this.shared('head', () => this.repo.head()) : this.repo.head();
  }

  /** The configured remotes; `shared` as for {@link status}. */
  remotes(read: { shared?: boolean } = {}): Promise<RemoteInfo[]> {
    return read.shared ? this.shared('remotes', () => readRemotes(this.repo)) : readRemotes(this.repo);
  }

  private async readRefs(): Promise<RefsSnapshot> {
    const [records, head] = await Promise.all([this.readRefRecords(), this.repo.head()]);
    const refs = parseRefRecords(records);
    // The remote's default branch, from refs/remotes/<remote>/HEAD (prefer "origin").
    let remoteHead: string | undefined;
    for (const [name, , , , , , , symref] of records) {
      if (name?.endsWith('/HEAD') && symref?.startsWith('refs/remotes/')) {
        const short = symref.slice('refs/remotes/'.length);
        if (!remoteHead || name === 'refs/remotes/origin/HEAD') remoteHead = short;
      }
    }
    return { refs, head, trunk: pickTrunk(refs, remoteHead) };
  }

  /**
   * `for-each-ref` records in {@link REFS_FORMAT}. Reading every ref's object is the slow part
   * (a second or so with 40,000 tags), so objects are remembered: later reads list the refs
   * without opening objects and read only the few new ones.
   */
  private async readRefRecords(): Promise<string[][]> {
    const options = { readOnly: true, background: true, label: 'Read refs' } as const;
    // Views load together: the first read opens every object, the others wait and reuse them.
    if (this.refObjects.size === 0 && this.fullRefRead) await this.fullRefRead.catch(() => undefined);
    if (this.refObjects.size > 0) {
      const { stdout } = await this.repo.git(
        ['for-each-ref', `--format=${REFS_FAST_FORMAT}`, ...REFS_PATTERNS],
        options,
      );
      const fast = splitRefRecords(stdout);
      const unknown = new Set<string>();
      for (const [, object, , , , symref] of fast) {
        if (object && !symref && !this.refObjects.has(object)) unknown.add(object);
      }
      if (unknown.size <= REF_OBJECTS_READ_MAX) {
        const objects = await this.catFile().readObjects([...unknown]);
        [...unknown].forEach((oid, index) => {
          const object = objects[index];
          if (object) this.rememberRefObject(oid, parseRefObject(object.type, object.data));
        });
        return composeRefRecords(fast, this.refObjects);
      }
    }
    const read = this.repo.git(['for-each-ref', `--format=${REFS_FORMAT}`, ...REFS_PATTERNS], options);
    this.fullRefRead = read;
    let stdout: string;
    try {
      ({ stdout } = await read);
    } finally {
      if (this.fullRefRead === read) this.fullRefRead = undefined;
    }
    const records = splitRefRecords(stdout);
    for (const [, type, object, peeled, , , , symref, created] of records) {
      if (!object || symref || !type) continue;
      this.rememberRefObject(object, {
        type,
        peeled: peeled || undefined,
        date: Number(created) || undefined,
      });
    }
    return records;
  }

  private rememberRefObject(oid: string, object: RefObject): void {
    if (this.refObjects.size >= REF_OBJECTS_LIMIT) this.refObjects.clear();
    this.refObjects.set(oid, object);
  }

  /** The repository changed (the watcher saw it, or an operation ran): reads in flight may be stale. */
  changed(): void {
    this.epoch++;
  }

  /**
   * `git status`. With `shared`, a read already running since the last reported change is
   * shared instead of starting another: views refreshing after one change ask for the status
   * several times at once, and in a working tree with thousands of changes each read takes
   * half a second. Operations never share: they read right after running git, before any
   * change is reported.
   */
  status(options: { allUntracked?: boolean; shared?: boolean } = {}): Promise<StatusResult> {
    if (!options.shared) return this.readStatus(options);
    return this.shared(options.allUntracked ? 'status:all' : 'status', () => this.readStatus(options));
  }

  /** The read of `key` running since the last reported change, or a new one others may share. */
  private shared<T>(key: string, read: () => Promise<T>): Promise<T> {
    const running = this.sharedReads.get(key);
    if (running?.epoch === this.epoch) return running.result as Promise<T>;
    const entry = { epoch: this.epoch, result: read() };
    this.sharedReads.set(key, entry);
    const done = () => {
      if (this.sharedReads.get(key) === entry) this.sharedReads.delete(key);
    };
    entry.result.then(done, done);
    return entry.result;
  }

  private async readStatus(options: { allUntracked?: boolean }): Promise<StatusResult> {
    const args = ['status', '--porcelain=v2', '--branch', '-z'];
    if (this.repo.runner.features.statusShowStash) args.push('--show-stash');
    if (options.allUntracked) args.push('--untracked-files=all');
    const { stdout } = await this.repo.git(args, { readOnly: true, background: true, label: 'Read status' });
    return parseStatus(stdout);
  }

  /** Uncommitted changes as file lists (staged, unstaged, untracked, conflicted). */
  async worktreeChanges(read: { shared?: boolean } = {}): Promise<WorktreeChanges> {
    const options = { readOnly: true, background: true } as const;
    const [status, staged, unstaged] = await Promise.all([
      this.status({ allUntracked: true, shared: read.shared }),
      this.repo.git(['diff', '--cached', ...DIFF_FLAGS], { ...options, label: 'Staged changes' }),
      this.repo.git(['diff', ...DIFF_FLAGS], { ...options, label: 'Unstaged changes' }),
    ]);
    const file = (path: string, status: ChangedFile['status']): ChangedFile => ({
      path,
      status,
      additions: 0,
      deletions: 0,
      binary: false,
    });
    // A conflicted submodule: the commits of the current and the incoming side.
    const conflicted = status.entries
      .filter((e) => e.kind === 'unmerged')
      .map((e) =>
        e.submodule
          ? { ...file(e.path, 'U'), submodule: { from: e.headOid, to: e.theirsOid } }
          : file(e.path, 'U'),
      );
    const conflictPaths = new Set(conflicted.map((f) => f.path));
    // Unmerged paths also show up in both diffs; they belong to the conflicts group only.
    const tracked = (output: string) =>
      parseRawNumstat(output).filter((f) => f.status !== 'U' && !conflictPaths.has(f.path));
    return {
      staged: tracked(staged.stdout),
      // Submodules: the commit checked out in each, and what is edited inside.
      unstaged: await completeSubmoduleChanges(this.repo, tracked(unstaged.stdout), status),
      untracked: status.entries.filter((e) => e.kind === 'untracked').map((e) => file(e.path, 'A')),
      conflicted,
    };
  }

  async workingTree(read: { shared?: boolean } = {}): Promise<WorkingTreeSummary> {
    // Counted like the file lists (every untracked file, not folders), so the numbers agree.
    return summarizeStatus(await this.status({ allUntracked: true, shared: read.shared }));
  }

  private async rawCommit(sha: string): Promise<RawCommit | undefined> {
    const bytes = await this.catFile().read(sha);
    return bytes ? parseCommit(bytes) : undefined;
  }

  private toMeta(sha: string, raw: RawCommit): CommitMeta {
    return {
      sha,
      parents: raw.parents,
      author: raw.author.name,
      authorEmail: raw.author.email,
      authorTime: raw.author.time,
      committer: raw.committer.name,
      committerEmail: raw.committer.email,
      committerTime: raw.committer.time,
      subject: subjectOf(raw.message),
      signed: raw.signed,
    };
  }

  /** Metadata for graph rows, served from one persistent `cat-file` process with an LRU cache. */
  async commitMetas(shas: readonly string[]): Promise<CommitMeta[]> {
    const missing = shas.filter((sha) => !this.metaCache.has(sha));
    if (missing.length > 0) {
      const raws = await Promise.all(missing.map((sha) => this.rawCommit(sha)));
      missing.forEach((sha, i) => {
        const raw = raws[i];
        if (raw) this.metaCache.set(sha, this.toMeta(sha, raw));
      });
      while (this.metaCache.size > META_CACHE_SIZE) {
        this.metaCache.delete(this.metaCache.keys().next().value as string);
      }
    }
    return shas.flatMap((sha) => {
      const meta = this.metaCache.get(sha);
      return meta ? [meta] : [];
    });
  }

  /**
   * Files changed between two revisions. `base` undefined means the empty tree; `target` may be
   * 'WORKTREE' (files on disk) or 'INDEX' (staged), and `base` may be 'INDEX' for unstaged changes.
   */
  async diffFiles(
    base: string | undefined,
    target: string,
    paths: readonly string[] = [],
  ): Promise<ChangedFile[]> {
    const from = base ?? emptyTree(this.repo.objectFormat);
    let args: string[];
    if (target === 'WORKTREE') args = ['diff', ...DIFF_FLAGS, ...(from === 'INDEX' ? [] : revisions(from))];
    else if (target === 'INDEX') args = ['diff', '--cached', ...DIFF_FLAGS, ...revisions(from)];
    else args = ['diff-tree', '-r', ...DIFF_FLAGS, ...revisions(from, target)];
    const { stdout } = await this.repo.git([...args, ...filePaths(...paths)], {
      readOnly: true,
      label: 'Changed files',
    });
    const files = parseRawNumstat(stdout);
    // On disk, a submodule is at the commit checked out in it (git's diff leaves it out).
    return target === 'WORKTREE' ? withCheckedOutCommits(this.repo, files) : files;
  }

  async commitDetails(sha: string): Promise<CommitDetails> {
    const raw = await this.rawCommit(sha);
    if (!raw) throw Object.assign(new Error(`Commit ${sha} not found`), { code: 'badRevision' });
    const diffBase = raw.parents[0];
    const files = await this.diffFiles(diffBase, sha);
    return { ...this.toMeta(sha, raw), body: bodyOf(raw.message), diffBase, files };
  }

  stashList(): Promise<StashEntry[]> {
    return readStashList(this.repo);
  }

  /** The files a stash holds: its working-tree changes, the staged part, and untracked files. */
  async stashDetails(sha: string): Promise<StashDetails> {
    const raw = await this.rawCommit(sha);
    if (!raw || raw.parents.length < 2)
      throw Object.assign(new Error(`${sha} is not a stash`), { code: 'badRevision' });
    const [base, indexCommit, untrackedCommit] = raw.parents as [string, string, string?];
    const [files, staged, untracked] = await Promise.all([
      this.diffFiles(base, sha),
      this.diffFiles(base, indexCommit),
      untrackedCommit ? this.diffFiles(undefined, untrackedCommit) : Promise.resolve([]),
    ]);
    return { sha, base, files, staged, untracked, indexCommit, untrackedCommit };
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const result = await this.repo.git(['merge-base', ...revisions(a, b)], {
      readOnly: true,
      label: 'Merge base',
      okExitCodes: [0, 1],
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /** Ahead/behind counts plus file changes between two revisions. */
  async compare(a: string, b: string, mode: 'three-dot' | 'two-dot' = 'three-dot'): Promise<CompareSummary> {
    const [mergeBase, counts] = await Promise.all([
      this.mergeBase(a, b),
      this.repo.git(['rev-list', '--left-right', '--count', ...revisions(`${a}...${b}`)], {
        readOnly: true,
        label: 'Compare',
      }),
    ]);
    const [onlyInA, onlyInB] = counts.stdout.trim().split(/\s+/).map(Number);
    const base = mode === 'three-dot' ? (mergeBase ?? emptyTree(this.repo.objectFormat)) : a;
    const files = await this.diffFiles(base, b);
    return { a, b, mergeBase, onlyInA: onlyInA ?? 0, onlyInB: onlyInB ?? 0, files, mode };
  }

  /**
   * Commits in a view's scope matching a search. Plain text runs as two queries (message, author)
   * whose results are merged; `truncated` reports that some query hit the limit.
   */
  async search(
    view: ViewConfig,
    head: HeadInfo,
    query: SearchQuery,
    limit = 2000,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const variants = searchArgs(view, head, query, limit);
    if (!variants) return { shas: [], truncated: false };
    const outputs = await Promise.all(
      variants.map((args) => this.repo.git(args, { readOnly: true, label: 'Search', signal })),
    );
    const seen = new Set<string>();
    let truncated = false;
    for (const { stdout } of outputs) {
      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length >= limit) truncated = true;
      for (const sha of lines) seen.add(sha);
    }
    return { shas: [...seen], truncated };
  }

  /** Commits reachable from `include` but not from `exclude` (newest first, capped). */
  async commitsBetween(exclude: string, include: string, limit = 500): Promise<string[]> {
    const { stdout } = await this.repo.git(
      ['rev-list', `--max-count=${limit}`, ...revisions(include, `^${exclude}`)],
      { readOnly: true, label: 'Commits between' },
    );
    return stdout.split('\n').filter(Boolean);
  }

  dispose(): void {
    this.reader?.dispose();
    this.reader = undefined;
    this.metaCache.clear();
  }
}
