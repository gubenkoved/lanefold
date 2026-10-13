import { basename, isAbsolute, join, resolve } from 'node:path';
import type { HeadInfo, RepoSummary } from '../../shared/models';
import { GitError } from '../git/errors';
import type { GitRunner, GitRunOptions } from '../git/runner';
import { paths } from '../util/paths';

export type ObjectFormat = 'sha1' | 'sha256';

/** A working-tree repository: paths resolved once, plus helpers that run git inside it. */
export class Repository {
  private constructor(
    readonly runner: GitRunner,
    /** Working tree root. Also the repository id. */
    readonly root: string,
    /** Per-worktree git dir (HEAD, index, rebase state live here). */
    readonly gitDir: string,
    /** Shared git dir (refs, objects, config); differs from gitDir in linked worktrees. */
    readonly commonDir: string,
    readonly objectFormat: ObjectFormat,
  ) {}

  /**
   * Opens the repository containing `path`. Returns `undefined` when `path` is not inside a
   * working tree (bare repositories are not supported as views).
   */
  static async open(runner: GitRunner, path: string): Promise<Repository | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await runner.run({
        cwd: path,
        args: [
          'rev-parse',
          '--show-toplevel',
          '--absolute-git-dir',
          '--git-common-dir',
          '--show-object-format',
          '--show-cdup',
        ],
        readOnly: true,
        background: true,
        label: 'Open repository',
      }));
    } catch (error) {
      if (error instanceof GitError && (error.kind === 'notARepository' || /work tree/.test(error.stderr))) {
        return undefined;
      }
      throw error;
    }
    const [topRaw, gitDirRaw, commonDirRaw, format, cdup = ''] = stdout.split(/\r?\n/);
    if (!topRaw || !gitDirRaw || !commonDirRaw) return undefined;
    // git prints the common dir relative to the cwd (but for linked worktrees).
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(path, commonDirRaw);
    // git names the root by its real path. Opened through a symbolic link (or a mapped drive),
    // keep the way the folder was opened instead: editors name files that way.
    const top = resolve(topRaw);
    const related =
      paths.relativeInside(top, path) !== undefined || paths.relativeInside(path, top) !== undefined;
    const root = related ? top : resolve(path, cdup);
    // The git dirs, likewise spelled the way the root is when they live inside it.
    const spelled = (dir: string) => {
      const inside = paths.relativeInside(top, dir) ?? paths.relativeInside(root, dir);
      return inside === undefined ? resolve(dir) : resolve(root, inside);
    };
    return new Repository(
      runner,
      root,
      spelled(gitDirRaw),
      spelled(commonDir),
      format === 'sha256' ? 'sha256' : 'sha1',
    );
  }

  get id(): string {
    return this.root;
  }

  get name(): string {
    return basename(this.root);
  }

  /** Path of a per-worktree state file (e.g. `rebase-merge/msgnum`), honoring linked worktrees. */
  gitPath(name: string): string {
    const shared =
      /^(?:refs|packed-refs|reftable|objects|config|hooks|info|logs\/refs|worktrees)(?:\/|$)/.test(name);
    return join(shared ? this.commonDir : this.gitDir, name);
  }

  summary(): RepoSummary {
    return { id: this.id, root: this.root, name: this.name, gitDir: this.gitDir, commonDir: this.commonDir };
  }

  /** Runs a git command in this repository. */
  git(args: readonly string[], options: Omit<GitRunOptions, 'cwd' | 'args'> = {}) {
    return this.runner.run({ cwd: this.root, args, ...options });
  }

  /** Runs a git command in this repository, keeping stdout as bytes (patches, file contents). */
  gitBuffer(args: readonly string[], options: Omit<GitRunOptions, 'cwd' | 'args'> = {}) {
    return this.runner.runBuffer({ cwd: this.root, args, ...options });
  }

  /** Runs a git command in this repository, handing stdout over chunk by chunk as it arrives. */
  gitStream(
    args: readonly string[],
    onStdout: (chunk: Buffer) => void,
    options: Omit<GitRunOptions, 'cwd' | 'args'> = {},
  ) {
    return this.runner.stream({ cwd: this.root, args, ...options }, onStdout);
  }

  async head(): Promise<HeadInfo> {
    const [symbolic, commit] = await Promise.all([
      this.git(['symbolic-ref', '-q', '--short', 'HEAD'], {
        readOnly: true,
        background: true,
        label: 'Current branch',
        okExitCodes: [0, 1],
      }),
      this.git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
        readOnly: true,
        background: true,
        label: 'Current commit',
        okExitCodes: [0, 1],
      }),
    ]);
    const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : undefined;
    const sha = commit.exitCode === 0 ? commit.stdout.trim() : undefined;
    return { branch, sha, detached: branch === undefined, unborn: sha === undefined };
  }
}
