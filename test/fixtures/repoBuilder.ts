import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findGit, type GitBinary } from '../../src/core/git/binary';
import { GitRunner, type GitRunnerOptions } from '../../src/core/git/runner';

/** First commit timestamp of every fixture repo (2024-01-01T00:00:00Z). */
export const FIXTURE_EPOCH = 1_704_067_200;

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export const ALICE: Identity = { name: 'Alice Archer', email: 'alice@example.com' };
export const BOB: Identity = { name: 'Bob Builder', email: 'bob@example.com' };

export interface CommitSpec {
  /** Files to write (string content) or delete (`null`). Defaults to a unique file per commit. */
  readonly files?: Readonly<Record<string, string | null>>;
  readonly author?: Identity;
  readonly allowEmpty?: boolean;
}

let gitBinary: Promise<GitBinary> | undefined;
export function testGitBinary(): Promise<GitBinary> {
  gitBinary ??= findGit([process.env.LANEFOLD_TEST_GIT]);
  return gitBinary;
}

/**
 * Environment that isolates fixture repos from the developer's / CI machine configuration
 * (signing, hooks, aliases, injected `GIT_CONFIG_*` values), so hashes are deterministic.
 */
export function isolatedGitEnv(globalConfigPath: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: ALICE.name,
    GIT_AUTHOR_EMAIL: ALICE.email,
    GIT_COMMITTER_NAME: ALICE.name,
    GIT_COMMITTER_EMAIL: ALICE.email,
  };
}

/** A throwaway repository with a tiny DSL for building histories in tests. */
export class TestRepo {
  /** Seconds since epoch used for the next commit; advances one minute per commit. */
  private clock = FIXTURE_EPOCH;
  private fileCounter = 0;

  private constructor(
    readonly path: string,
    private readonly root: string,
    readonly runner: GitRunner,
    readonly env: Record<string, string>,
  ) {}

  static async create(
    options: { bare?: boolean; initialBranch?: string; runnerOptions?: GitRunnerOptions } = {},
  ): Promise<TestRepo> {
    const root = await mkdtemp(join(process.env.LANEFOLD_TEST_TMP ?? tmpdir(), 'lanefold-test-'));
    const path = join(root, options.bare ? 'repo.git' : 'repo');
    await mkdir(path, { recursive: true });
    const globalConfig = join(root, 'gitconfig');
    await writeFile(globalConfig, '');
    const env = isolatedGitEnv(globalConfig);
    const runner = new GitRunner(await testGitBinary(), {
      ...options.runnerOptions,
      env: { ...env, ...options.runnerOptions?.env },
    });
    const repo = new TestRepo(path, root, runner, env);
    await repo.git(
      'init',
      '-q',
      `--initial-branch=${options.initialBranch ?? 'main'}`,
      ...(options.bare ? ['--bare'] : []),
    );
    return repo;
  }

  /** Runs git in this repo and returns trimmed stdout. */
  async git(...args: string[]): Promise<string> {
    const result = await this.runner.run({ cwd: this.path, args, env: this.dateEnv() });
    return result.stdout.trimEnd();
  }

  /** Like {@link git} but returns stdout untrimmed (for byte-exact parser fixtures). */
  async gitRaw(...args: string[]): Promise<string> {
    return (await this.runner.run({ cwd: this.path, args, env: this.dateEnv() })).stdout;
  }

  private dateEnv(): Record<string, string> {
    const date = `${this.clock} +0000`;
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  }

  /** Sets the date of the next commit (ISO date or date-time, UTC). */
  at(date: string): this {
    this.clock = Math.floor(Date.parse(date.includes('T') ? date : `${date}T10:00:00Z`) / 1000);
    return this;
  }

  async write(file: string, content: string): Promise<void> {
    const full = join(this.path, file);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async remove(file: string): Promise<void> {
    await unlink(join(this.path, file));
  }

  /** Creates a commit and returns its full hash. */
  async commit(message: string, spec: CommitSpec = {}): Promise<string> {
    const files = spec.files ?? { [`file-${++this.fileCounter}.txt`]: `${message}\n` };
    for (const [file, content] of Object.entries(files)) {
      if (content === null) await this.git('rm', '-q', '--', file);
      else {
        await this.write(file, content);
        await this.git('add', '--', file);
      }
    }
    const author = spec.author ?? ALICE;
    await this.runner.run({
      cwd: this.path,
      args: ['commit', '-q', '--no-verify', ...(spec.allowEmpty ? ['--allow-empty'] : []), '-m', message],
      env: {
        ...this.dateEnv(),
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
      },
    });
    this.clock += 60;
    return this.rev('HEAD');
  }

  /** Creates several commits in a row; returns their hashes oldest-first. */
  async commits(...messages: string[]): Promise<string[]> {
    const shas: string[] = [];
    for (const message of messages) shas.push(await this.commit(message));
    return shas;
  }

  async branch(name: string, startPoint = 'HEAD'): Promise<void> {
    await this.git('branch', name, startPoint);
  }

  async checkout(ref: string): Promise<void> {
    await this.git('checkout', '-q', ref);
  }

  /** `git checkout -b <name> [startPoint]` */
  async checkoutNew(name: string, startPoint = 'HEAD'): Promise<void> {
    await this.git('checkout', '-q', '-b', name, startPoint);
  }

  async merge(ref: string, options: { noFF?: boolean; message?: string } = {}): Promise<string> {
    await this.git(
      'merge',
      '-q',
      ...(options.noFF ? ['--no-ff'] : []),
      '-m',
      options.message ?? `Merge ${ref}`,
      ref,
    );
    this.clock += 60;
    return this.rev('HEAD');
  }

  async tag(name: string, options: { message?: string; ref?: string } = {}): Promise<void> {
    await this.git(
      'tag',
      ...(options.message ? ['-a', '-m', options.message] : []),
      name,
      options.ref ?? 'HEAD',
    );
  }

  async rev(ref: string): Promise<string> {
    return this.git('rev-parse', '--verify', `${ref}^{commit}`);
  }

  /** Subjects along `range` (newest first), e.g. `log('main')` or `log('HEAD', '%s|%an')`. */
  async log(range = 'HEAD', format = '%s'): Promise<string[]> {
    const out = await this.git('log', `--format=${format}`, range);
    return out.length === 0 ? [] : out.split('\n');
  }

  async addRemote(name: string, remote: TestRepo): Promise<void> {
    await this.git('remote', 'add', name, remote.path);
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
