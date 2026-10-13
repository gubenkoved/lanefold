import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative as relativePath, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessPlatform } from '../../dev/harness/platform';
import { Backend } from '../../src/core/backend/backend';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { GitRunner } from '../../src/core/git/runner';
import { RepoOperations } from '../../src/core/ops/operations';
import { RepoData } from '../../src/core/repo/repoData';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import { Repository } from '../../src/core/repo/repository';
import { readSubmodules } from '../../src/core/repo/submodules';
import { readWorktrees } from '../../src/core/repo/worktrees';
import type { Operation, OperationPlan } from '../../src/shared/operations';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/**
 * Modern git refuses to clone submodules over the file transport unless allowed: the fixtures
 * (and only they) allow it, through the environment of the test's git runner.
 */
const ALLOW_FILE_PROTOCOL = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};

describe('submodules (real git)', () => {
  let lib: TestRepo;
  let test: TestRepo;
  let repo: Repository;
  let data: RepoData;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  let libCommits: string[];
  const cleanup: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    lib = await TestRepo.create();
    libCommits = await lib.commits('lib one', 'lib two', 'lib three');
    test = await TestRepo.create({ runnerOptions: { env: ALLOW_FILE_PROTOCOL } });
    await test.commit('base');
    await test.git('submodule', 'add', '-q', '--', lib.path, 'libs/lib');
    await test.git('commit', '-q', '-m', 'Add lib');
    ({ repo, data, ops, run, dispose } = await openOps(test));
  });

  afterEach(async () => {
    for (const step of cleanup.splice(0)) await step();
    await dispose();
    await lib.dispose();
  });

  /** git inside the submodule's folder. */
  const sub = (...args: string[]) =>
    test.runner.run({ cwd: join(test.path, 'libs/lib'), args }).then((result) => result.stdout.trim());

  async function plan(operation: Operation): Promise<OperationPlan> {
    return ops.plan(operation);
  }

  const notices = (planned: OperationPlan) => planned.notices.map((notice) => notice.text).join('\n');

  /** A clone of the repository, its submodule not initialized. */
  async function cloneOf(env: Record<string, string> = {}): Promise<{ path: string; ops: RepoOperations }> {
    const folder = await mkdtemp(join(tmpdir(), 'lanefold-submodule-clone-'));
    const path = join(folder, 'clone');
    await test.git('clone', '-q', test.path, path);
    const runner = new GitRunner(test.runner.binary, { env: { ...test.env, ...env } });
    const cloned = (await Repository.open(runner, path))!;
    const clonedData = new RepoData(cloned);
    const clonedOps = new RepoOperations(cloned, clonedData);
    cleanup.push(() => {
      clonedOps.dispose();
      clonedData.dispose();
    });
    cleanup.push(() => rm(folder, { recursive: true, force: true }));
    return { path, ops: clonedOps };
  }

  it('lists a submodule with its URL and the commits recorded and checked out', async () => {
    const [submodule] = await readSubmodules(repo);
    expect(submodule).toEqual({
      name: 'libs/lib',
      path: 'libs/lib',
      url: lib.path,
      branch: undefined,
      head: libCommits[2],
      recorded: libCommits[2],
      checkedOut: libCommits[2],
      state: 'upToDate',
      modified: false,
      untracked: false,
      nested: false,
    });
  });

  it('tells another commit checked out, uncommitted changes, and a staged change apart', async () => {
    await sub('checkout', '-q', libCommits[1]!);
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'otherCommit', recorded: libCommits[2], checkedOut: libCommits[1] }),
    ]);

    await sub('checkout', '-q', 'main');
    writeFileSync(join(test.path, 'libs/lib/file-1.txt'), 'edited\n');
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'dirty', modified: true, untracked: false }),
    ]);
    await sub('checkout', '-q', '--', '.');
    writeFileSync(join(test.path, 'libs/lib/new.txt'), 'new\n');
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'dirty', modified: false, untracked: true }),
    ]);
    await sub('clean', '-fq');

    // Another commit, staged here: it is what the index records now (HEAD still has the old one).
    await sub('checkout', '-q', libCommits[0]!);
    await test.git('add', 'libs/lib');
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({
        state: 'upToDate',
        head: libCommits[2],
        recorded: libCommits[0],
        checkedOut: libCommits[0],
      }),
    ]);
  });

  it('lists a submodule of a fresh clone as not initialized', async () => {
    const clone = await cloneOf();
    const cloned = (await Repository.open(test.runner, clone.path))!;
    expect(await readSubmodules(cloned)).toEqual([
      expect.objectContaining({ state: 'uninitialized', recorded: libCommits[2], checkedOut: undefined }),
    ]);
  });

  it('updates a submodule at another commit: its HEAD moves back, nothing is journaled', async () => {
    await sub('checkout', '-q', libCommits[0]!);
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(planned.title).toBe('Update libs/lib');
    expect(planned.commands[0]!.args).toEqual(['submodule', 'update', '--', 'libs/lib']);
    expect(notices(planned)).toContain(
      `libs/lib’s HEAD moves from ${libCommits[0]!.slice(0, 8)} to ${libCommits[2]!.slice(0, 8)}, detached from any branch.`,
    );
    expect(notices(planned)).toContain('Undo cannot take back');
    expect(planned.destructive).toBe(false);
    const result = await ops.execute(planned.id);
    expect(result.status).toBe('done');
    expect(result.message).toBe('libs/lib is at the commit this repository records.');
    expect(await sub('rev-parse', 'HEAD')).toBe(libCommits[2]);
    expect(ops.undoInfo.undo).toBeUndefined();
    // Up to date now: nothing left to do.
    expect((await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] })).blocked).toBe(true);
  });

  it('names the branch the submodule’s HEAD leaves', async () => {
    await sub('reset', '-q', '--hard', libCommits[1]!);
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(notices(planned)).toContain('detached from main (which stays where it is)');
  });

  it('warns before moving away from commits on no branch', async () => {
    await sub('checkout', '-q', '--detach');
    writeFileSync(join(test.path, 'libs/lib/work.txt'), 'work\n');
    await sub('add', 'work.txt');
    await sub('commit', '-q', '-m', 'work in detached HEAD');
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(planned.destructive).toBe(true);
    expect(notices(planned)).toContain('1 commit checked out in libs/lib is on no branch');
  });

  it('stops, with the submodule untouched, when its changes are in the way', async () => {
    await sub('checkout', '-q', libCommits[0]!);
    // lib two added file-2.txt: a different file-2.txt here is in the way of checking it out.
    writeFileSync(join(test.path, 'libs/lib/file-2.txt'), 'mine\n');
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(notices(planned)).toContain('libs/lib has uncommitted changes');
    const result = await ops.execute(planned.id);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/^Uncommitted changes in libs\/lib/);
    expect(await sub('rev-parse', 'HEAD')).toBe(libCommits[0]);
  });

  it('refuses to update an uninitialized submodule unless asked to initialize it, then clones it', async () => {
    const clone = await cloneOf(ALLOW_FILE_PROTOCOL);
    const refused = await clone.ops.plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(refused.blocked).toBe(true);
    expect(notices(refused)).toContain('libs/lib is not initialized yet');

    const planned = await clone.ops.plan({ kind: 'updateSubmodules', paths: ['libs/lib'], init: true });
    expect(planned.title).toBe('Initialize libs/lib');
    expect(planned.commands[0]!.args).toEqual(['submodule', 'update', '--init', '--', 'libs/lib']);
    expect(notices(planned)).toContain(`libs/lib is cloned from ${lib.path}`);
    expect((await clone.ops.execute(planned.id)).status).toBe('done');
    const cloned = (await Repository.open(test.runner, clone.path))!;
    expect(await readSubmodules(cloned)).toEqual([
      expect.objectContaining({ state: 'upToDate', checkedOut: libCommits[2] }),
    ]);
  });

  it('says clearly when git refuses to clone from a local folder', async () => {
    const clone = await cloneOf();
    const result = await clone.ops.execute(
      (await clone.ops.plan({ kind: 'updateSubmodules', init: true })).id,
    );
    expect(result.status).toBe('failed');
    expect(result.message).toContain('protocol.file.allow');
  });

  it('adds a submodule: clones it and stages .gitmodules and the gitlink', async () => {
    const planned = await plan({ kind: 'addSubmodule', url: lib.path, path: 'vendor/lib/', branch: 'main' });
    expect(planned.title).toBe('Add the submodule vendor/lib');
    expect(planned.commands[0]!.args).toEqual([
      'submodule',
      'add',
      '-b',
      'main',
      '--',
      lib.path,
      'vendor/lib',
    ]);
    expect(notices(planned)).toContain('protocol.file.allow');
    const result = await ops.execute(planned.id);
    expect(result.status).toBe('done');
    expect(ops.undoInfo.undo).toBeUndefined();
    expect((await test.git('diff', '--cached', '--name-only')).split('\n')).toEqual([
      '.gitmodules',
      'vendor/lib',
    ]);
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ path: 'libs/lib' }),
      expect.objectContaining({ path: 'vendor/lib', branch: 'main', head: undefined, state: 'upToDate' }),
    ]);
  });

  it('checks the URL and the folder before adding', async () => {
    mkdirSync(join(test.path, 'docs'));
    writeFileSync(join(test.path, 'docs/readme.txt'), 'hello\n');
    const blocked = async (url: string, path: string) => {
      const planned = await plan({ kind: 'addSubmodule', url, path });
      return planned.blocked ? notices(planned) : undefined;
    };
    expect(await blocked('', 'x')).toContain('Enter the URL');
    expect(await blocked('--upload-pack=touch /tmp/x', 'x')).toContain('starts with “-”');
    expect(await blocked('https://user:secret@example.com/lib.git', 'x')).toContain('password or token');
    expect(await blocked(lib.path, '../outside')).toContain('not a folder inside this repository');
    expect(await blocked(lib.path, '.git/hooks')).toContain('cannot go in .git/hooks');
    expect(await blocked(lib.path, 'docs')).toContain('docs already exists and is not an empty folder');
    expect(await blocked(lib.path, 'file-1.txt')).toContain('already tracked');
    expect(await blocked(lib.path, 'libs/lib/inner')).toContain('taken by the submodule libs/lib');
    expect(await blocked(lib.path, '')).toContain('Choose a folder');
    expect(await blocked(lib.path, 'fresh')).toBeUndefined();
  });

  it('says clearly when git refuses to add from a local folder', async () => {
    const strict = await TestRepo.create();
    cleanup.push(() => strict.dispose());
    await strict.commit('base');
    const strictRepo = (await Repository.open(strict.runner, strict.path))!;
    const strictData = new RepoData(strictRepo);
    const strictOps = new RepoOperations(strictRepo, strictData);
    cleanup.push(() => {
      strictOps.dispose();
      strictData.dispose();
    });
    const planned = await strictOps.plan({ kind: 'addSubmodule', url: lib.path, path: 'lib' });
    const result = await strictOps.execute(planned.id);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Git refuses to clone or fetch a submodule from a local folder');
  });

  it('shows submodule changes in commits as the commits they record', async () => {
    const added = await data.commitDetails(await test.rev('HEAD'));
    expect(added.files).toEqual([
      expect.objectContaining({ path: '.gitmodules', status: 'A' }),
      expect.objectContaining({
        path: 'libs/lib',
        status: 'A',
        submodule: { from: undefined, to: libCommits[2] },
      }),
    ]);
    expect(added.files[0]!.submodule).toBeUndefined();

    await sub('checkout', '-q', libCommits[0]!);
    await test.git('add', 'libs/lib');
    await test.git('commit', '-q', '-m', 'Move lib back');
    const moved = await data.commitDetails(await test.rev('HEAD'));
    expect(moved.files).toEqual([
      expect.objectContaining({
        path: 'libs/lib',
        status: 'M',
        submodule: { from: libCommits[2], to: libCommits[0] },
      }),
    ]);
  });

  it('shows submodule changes in the working tree: the commit checked out, edited and new files', async () => {
    await sub('checkout', '-q', libCommits[1]!);
    let changes = await data.worktreeChanges();
    expect(changes.unstaged).toEqual([
      expect.objectContaining({
        path: 'libs/lib',
        submodule: { from: libCommits[2], to: libCommits[1], modified: false, untracked: false },
      }),
    ]);

    // Staged: the index now records the other commit.
    await test.git('add', 'libs/lib');
    changes = await data.worktreeChanges();
    expect(changes.staged).toEqual([
      expect.objectContaining({ path: 'libs/lib', submodule: { from: libCommits[2], to: libCommits[1] } }),
    ]);
    expect(changes.unstaged).toEqual([]);
    await test.git('reset', '-q', '--', 'libs/lib');

    await sub('checkout', '-q', 'main');
    writeFileSync(join(test.path, 'libs/lib/file-1.txt'), 'edited\n');
    changes = await data.worktreeChanges();
    expect(changes.unstaged).toEqual([
      expect.objectContaining({
        path: 'libs/lib',
        submodule: { from: libCommits[2], to: libCommits[2], modified: true, untracked: false },
      }),
    ]);

    // Only new files inside: git's diff leaves the submodule out, the list does not.
    await sub('checkout', '-q', '--', '.');
    writeFileSync(join(test.path, 'libs/lib/new.txt'), 'new\n');
    changes = await data.worktreeChanges();
    expect(changes.unstaged).toEqual([
      expect.objectContaining({
        path: 'libs/lib',
        status: 'M',
        submodule: { from: libCommits[2], to: libCommits[2], modified: false, untracked: true },
      }),
    ]);
    expect(await data.workingTree()).toEqual(expect.objectContaining({ unstaged: 1 }));
  });

  it('lists a submodule two branches moved apart as conflicted, with both sides’ commits', async () => {
    await test.git('checkout', '-q', '-b', 'side');
    await sub('checkout', '-q', libCommits[0]!);
    await test.git('add', 'libs/lib');
    await test.git('commit', '-q', '-m', 'side: lib one');
    await test.git('checkout', '-q', 'main');
    await sub('checkout', '-q', libCommits[1]!);
    await test.git('add', 'libs/lib');
    await test.git('commit', '-q', '-m', 'main: lib two');
    await expect(test.git('merge', 'side')).rejects.toThrow();

    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'conflicted', head: libCommits[1], recorded: undefined }),
    ]);
    expect((await data.worktreeChanges()).conflicted).toEqual([
      expect.objectContaining({ path: 'libs/lib', submodule: { from: libCommits[1], to: libCommits[0] } }),
    ]);
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(notices(planned)).toContain('libs/lib has a merge conflict');

    // The stop's state names the commit each side records, and the one checked out.
    expect((await ops.opState()).submodules).toEqual([
      { path: 'libs/lib', ours: libCommits[1], theirs: libCommits[0], checkedOut: libCommits[1] },
    ]);
    // No text to take a side of or to merge.
    await expect(ops.resolveConflict('libs/lib', 'ours')).rejects.toThrow('libs/lib is a submodule');
    // Recording the incoming side's commit resolves it; the folder keeps its checkout.
    expect(await ops.recordSubmoduleConflict('libs/lib', 'theirs')).toEqual({
      recorded: libCommits[0],
      checkedOut: libCommits[1],
    });
    expect(await test.git('ls-files', '--stage', '--', 'libs/lib')).toBe(
      `160000 ${libCommits[0]} 0\tlibs/lib`,
    );
    const after = await ops.opState();
    expect(after.conflicts).toEqual([]);
    expect(after.submodules).toBeUndefined();
    await expect(ops.recordSubmoduleConflict('libs/lib', 'ours')).rejects.toThrow(
      'not a conflicted submodule',
    );
  });

  it('tells a deleted folder apart from a submodule never set up, and checks it out again', async () => {
    await rm(join(test.path, 'libs/lib'), { recursive: true, force: true });
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'missing', recorded: libCommits[2], checkedOut: undefined }),
    ]);
    // Among the changes: deleted, nothing checked out.
    expect((await data.worktreeChanges()).unstaged).toEqual([
      expect.objectContaining({
        path: 'libs/lib',
        status: 'D',
        submodule: { from: libCommits[2], to: undefined, modified: false, untracked: false },
      }),
    ]);
    // Still set up here: no --init needed, nothing cloned.
    const planned = await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] });
    expect(planned.commands[0]!.args).toEqual(['submodule', 'update', '--', 'libs/lib']);
    expect(notices(planned)).toContain(
      'libs/lib is not checked out (its folder is gone or empty): git checks it out again from its repository, kept in .git/modules.',
    );
    expect((await ops.execute(planned.id)).status).toBe('done');
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ state: 'upToDate', checkedOut: libCommits[2] }),
    ]);
  });

  it('notices a URL that .gitmodules changed, until it is synced', async () => {
    const other = await TestRepo.create();
    cleanup.push(() => other.dispose());
    await other.commit('other one');
    await test.git('config', '-f', '.gitmodules', 'submodule.libs/lib.url', other.path);
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ url: other.path, settingsUrl: lib.path }),
    ]);
    // A commit the submodule has not fetched yet: the update fetches it, from the old URL.
    const newer = await lib.commit('lib four');
    await test.git('update-index', '--cacheinfo', `160000,${newer},libs/lib`);
    const update = notices(await plan({ kind: 'updateSubmodules', paths: ['libs/lib'] }));
    expect(update).toContain(`libs/lib does not have ${newer.slice(0, 8)} yet: git fetches it first`);
    expect(update).toContain(`It still fetches from ${lib.path}, but .gitmodules says ${other.path} now`);
    const sync = await plan({ kind: 'syncSubmodules', paths: ['libs/lib'] });
    expect(notices(sync)).toContain(`libs/lib: ${lib.path} → ${other.path}.`);
    expect((await ops.execute(sync.id)).status).toBe('done');
    expect((await readSubmodules(repo))[0]!.settingsUrl).toBeUndefined();
  });

  it('resolves a relative URL the way git does', async () => {
    const relative = relativePath(test.path, lib.path).split(sep).join('/');
    expect(relative.startsWith('../')).toBe(true);
    await test.git('submodule', 'add', '-q', '--', relative, 'libs/again');
    expect((await readSubmodules(repo)).find((submodule) => submodule.path === 'libs/again')).toEqual(
      expect.objectContaining({ url: lib.path, settingsUrl: undefined, state: 'upToDate' }),
    );
  });

  it('moves with git mv: a rename of the submodule, found under its new path', async () => {
    mkdirSync(join(test.path, 'vendor'));
    await test.git('mv', 'libs/lib', 'vendor/lib');
    expect((await data.worktreeChanges()).staged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'vendor/lib',
          oldPath: 'libs/lib',
          status: 'R',
          submodule: { from: libCommits[2], to: libCommits[2] },
        }),
      ]),
    );
    expect(await readSubmodules(repo)).toEqual([
      expect.objectContaining({ name: 'libs/lib', path: 'vendor/lib', state: 'upToDate' }),
    ]);
  });

  it('says where a clone failed from, and the submodule stays set up but not checked out', async () => {
    const clone = await cloneOf(ALLOW_FILE_PROTOCOL);
    const missing = join(tmpdir(), `lanefold-missing-${process.pid}`);
    await test.runner.run({
      cwd: clone.path,
      args: ['config', '-f', '.gitmodules', 'submodule.libs/lib.url', missing],
    });
    const result = await clone.ops.execute(
      (await clone.ops.plan({ kind: 'updateSubmodules', paths: ['libs/lib'], init: true })).id,
    );
    expect(result.status).toBe('failed');
    expect(result.message).toBe(
      `Could not clone libs/lib from ${missing}: repository '${missing}' does not exist. Check its URL in .gitmodules (then sync it).`,
    );
    const cloned = (await Repository.open(test.runner, clone.path))!;
    expect(await readSubmodules(cloned)).toEqual([expect.objectContaining({ state: 'missing' })]);
  });

  it('removes the checkout of a clean submodule, and refuses while it has changes', async () => {
    writeFileSync(join(test.path, 'libs/lib/file-1.txt'), 'edited\n');
    const refused = await plan({ kind: 'deinitSubmodules', paths: ['libs/lib'] });
    expect(refused.blocked).toBe(true);
    expect(notices(refused)).toContain('libs/lib has uncommitted changes');
    await sub('checkout', '-q', '--', '.');

    const result = await run({ kind: 'deinitSubmodules', paths: ['libs/lib'] });
    expect(result.status).toBe('done');
    expect(await readSubmodules(repo)).toEqual([expect.objectContaining({ state: 'uninitialized' })]);
  });

  it('syncs URLs from .gitmodules', async () => {
    const planned = await plan({ kind: 'syncSubmodules' });
    expect(planned.commands[0]!.args).toEqual(['submodule', 'sync']);
    expect((await ops.execute(planned.id)).status).toBe('done');
  });

  it('refuses paths that are not submodules', async () => {
    const planned = await plan({ kind: 'updateSubmodules', paths: ['file-1.txt'] });
    expect(planned.blocked).toBe(true);
    expect(notices(planned)).toContain('file-1.txt is not a submodule of this repository');
  });
});

/** A webview as the backend sees it: calls methods, keeps events. */
class View implements RpcTransport {
  private handler: ((message: RpcMessage) => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  send(message: RpcMessage): void {
    if (message.kind === 'res') this.pending.get(message.id)?.(message);
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.kind !== 'res') return;
        if (message.ok) resolve(message.result as T);
        else reject(new Error(message.error.message));
      });
      this.handler?.({ kind: 'req', id, method, params });
    });
  }
}

describe('opening a submodule in Lanefold (real git)', () => {
  let lib: TestRepo;
  let test: TestRepo;
  let backend: Backend;
  let registry: RepositoryRegistry;

  beforeEach(async () => {
    lib = await TestRepo.create();
    await lib.commits('lib one');
    test = await TestRepo.create({ runnerOptions: { env: ALLOW_FILE_PROTOCOL } });
    await test.commit('base', { files: { 'src/app.txt': 'app\n' } });
    await test.git('submodule', 'add', '-q', '--', lib.path, 'libs/lib');
    await test.git('commit', '-q', '-m', 'Add lib');
    registry = new RepositoryRegistry();
    const platform = new HarnessPlatform();
    platform.opener = async (folder) => {
      const opened = await Repository.open(test.runner, folder);
      if (opened) registry.add(opened);
      return opened && registry.get(opened.id);
    };
    backend = new Backend({ platform, registry, console: new ConsoleLog() });
    backend.setGit(test.runner);
    registry.add((await Repository.open(test.runner, test.path))!);
  });

  afterEach(async () => {
    backend.dispose();
    await test.dispose();
    await lib.dispose();
  });

  it('switches to the submodule’s repository, and refuses any other folder', async () => {
    const view = new View();
    backend.connect(view);
    const repoId = registry.active!.id;
    const opened = await view.call<{ repoId: string }>('repo.openLinked', { repoId, path: 'libs/lib' });
    expect(opened.repoId).toBe(join(test.path, 'libs/lib'));
    expect(registry.active?.id).toBe(opened.repoId);
    expect(registry.all).toHaveLength(2);

    for (const path of ['src', '../', lib.path, '.git', '']) {
      await expect(view.call('repo.openLinked', { repoId, path })).rejects.toThrow(
        /is not a submodule or worktree|Name a submodule/,
      );
    }
    expect(registry.all).toHaveLength(2);

    // Opening it again only switches back to it.
    registry.setActive(repoId);
    await view.call('repo.openLinked', { repoId, path: 'libs/lib' });
    expect(registry.active?.id).toBe(opened.repoId);
    expect(registry.all).toHaveLength(2);
  });

  it('says when the submodule is not initialized', async () => {
    const view = new View();
    backend.connect(view);
    await test.git('submodule', 'deinit', '-q', '--', 'libs/lib');
    await expect(
      view.call('repo.openLinked', { repoId: registry.active!.id, path: 'libs/lib' }),
    ).rejects.toThrow('libs/lib is not checked out here');
  });

  it('switches to another worktree of the repository', async () => {
    const view = new View();
    backend.connect(view);
    // Next to the repository, in the fixture's folder (removed with it).
    const folder = `${test.path}-feature`;
    await test.git('worktree', 'add', '-q', '-b', 'feature', folder);
    const repoId = registry.active!.id;
    const opened = await view.call<{ repoId: string }>('repo.openLinked', { repoId, path: folder });
    expect(opened.repoId).toBe(folder);
    expect(registry.active?.id).toBe(folder);
  });

  it('knows the submodule’s folder as its worktree (git names its .git/modules folder)', async () => {
    const opened = (await Repository.open(test.runner, join(test.path, 'libs/lib')))!;
    expect(await readWorktrees(opened)).toEqual([
      expect.objectContaining({ path: opened.root, branch: 'main', main: true, current: true }),
    ]);
  });
});
