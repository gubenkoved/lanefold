import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/core/git/runner';
import { Repository } from '../../src/core/repo/repository';
import { readWorktrees } from '../../src/core/repo/worktrees';
import { TestRepo, testGitBinary } from '../fixtures/repoBuilder';

describe('Repository', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  async function fixture(): Promise<TestRepo> {
    const repo = await TestRepo.create();
    cleanup.push(() => repo.dispose());
    return repo;
  }

  it('opens from the root and from a subdirectory', async () => {
    const t = await fixture();
    await t.commit('init', { files: { 'src/deep/file.txt': 'x' } });
    // As opened (temp folders are symbolic links on macOS: git's real path is not used then).
    const root = t.path;
    const fromRoot = await Repository.open(t.runner, t.path);
    const fromSub = await Repository.open(t.runner, join(t.path, 'src', 'deep'));
    expect(fromRoot?.root).toBe(root);
    expect(fromSub?.root).toBe(root);
    expect(fromRoot?.gitDir).toBe(join(root, '.git'));
    expect(fromRoot?.commonDir).toBe(join(root, '.git'));
    expect(fromRoot?.objectFormat).toBe('sha1');
    expect(fromRoot?.summary()).toMatchObject({ id: root, name: 'repo' });
  });

  it.skipIf(process.platform === 'win32')(
    'opened through a symbolic link, keeps the folder’s spelling (editors name files that way)',
    async () => {
      const t = await fixture();
      await t.commit('init', { files: { 'src/a.txt': 'a' } });
      const dir = await mkdtemp(join(tmpdir(), 'lanefold-link-'));
      cleanup.push(() => rm(dir, { recursive: true, force: true }));
      const link = join(dir, 'linked');
      await symlink(t.path, link);

      const fromLink = await Repository.open(t.runner, link);
      expect(fromLink?.root).toBe(link);
      expect(fromLink?.gitDir).toBe(join(link, '.git'));
      expect(fromLink?.commonDir).toBe(join(link, '.git'));
      const fromSub = await Repository.open(t.runner, join(link, 'src'));
      expect(fromSub?.root).toBe(link);
      // The worktree list (real paths) still knows which worktree this is.
      const [main] = await readWorktrees(fromLink!);
      expect(main).toMatchObject({ current: true });
    },
  );

  it('returns undefined outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lanefold-norepo-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const t = await fixture();
    // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir.
    const runner = new GitRunner(await testGitBinary(), {
      env: { ...t.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    expect(await Repository.open(runner, dir)).toBeUndefined();
  });

  it('distinguishes the git dir from the common dir in linked worktrees', async () => {
    const t = await fixture();
    await t.commit('init');
    const worktreePath = join(t.path, '..', 'wt');
    await t.git('worktree', 'add', '-q', '-b', 'side', worktreePath);
    const repo = await Repository.open(t.runner, worktreePath);
    const mainGitDir = join(await realpath(t.path), '.git');
    expect(repo?.commonDir).toBe(mainGitDir);
    expect(repo?.gitDir).toBe(join(mainGitDir, 'worktrees', 'wt'));
    expect(repo?.gitPath('rebase-merge')).toBe(join(mainGitDir, 'worktrees', 'wt', 'rebase-merge'));
    expect(repo?.gitPath('refs/heads')).toBe(join(mainGitDir, 'refs', 'heads'));
    expect(await repo?.head()).toMatchObject({ branch: 'side', detached: false, unborn: false });
  });

  it('reports unborn, attached and detached HEAD', async () => {
    const t = await fixture();
    const repo = (await Repository.open(t.runner, t.path))!;
    expect(await repo.head()).toEqual({ branch: 'main', sha: undefined, detached: false, unborn: true });
    const [first, second] = await t.commits('one', 'two');
    expect(await repo.head()).toEqual({ branch: 'main', sha: second, detached: false, unborn: false });
    await t.checkout(first!);
    expect(await repo.head()).toEqual({ branch: undefined, sha: first, detached: true, unborn: false });
  });
});
