import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchChoices,
  hasUntrackedFiles,
  headStatus,
  recentBranches,
} from '../../src/core/repo/branchChoices';
import { Repository } from '../../src/core/repo/repository';
import { TestRepo } from '../fixtures/repoBuilder';

describe('branch choices (real git)', () => {
  let origin: TestRepo;
  let local: TestRepo;
  let repo: Repository;

  beforeEach(async () => {
    origin = await TestRepo.create();
    await origin.at('2024-01-01').commit('base');
    await origin.branch('remote-only');
    local = await TestRepo.create();
    await local.addRemote('origin', origin);
    await local.git('fetch', '-q', 'origin');
    // Not a checkout: the reflog of HEAD starts without one.
    await local.git('reset', '-q', '--hard', 'origin/main');
    await local.git('branch', '-q', '--set-upstream-to=origin/main');
    repo = (await Repository.open(local.runner, local.path))!;
  });

  afterEach(async () => {
    await local.dispose();
    await origin.dispose();
  });

  it('lists local and remote branches, newest first, with their upstream and how far apart they are', async () => {
    await local.at('2024-02-01').commit('mine');
    await origin.at('2024-03-01').commits('theirs one', 'theirs two');
    await local.git('fetch', '-q', 'origin');
    await local.branch('topic', 'HEAD~1');

    const choices = await branchChoices(repo);
    const names = choices.map((choice) => `${choice.kind}:${choice.name}`);
    expect(names.slice(0, 2)).toEqual(['remote:origin/main', 'branch:main']);
    // Both at the base commit.
    expect(names.slice(2).sort()).toEqual(['branch:topic', 'remote:origin/remote-only']);
    expect(choices.find((choice) => choice.name === 'main')).toMatchObject({
      current: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      subject: 'mine',
      sha: await local.rev('main'),
    });
    expect(choices.find((choice) => choice.name === 'topic')).toMatchObject({
      current: false,
      upstream: undefined,
      ahead: undefined,
      behind: undefined,
    });
    // origin/HEAD (a symbolic ref) is not a branch to offer.
    await local.git('remote', 'set-head', 'origin', 'main');
    expect((await branchChoices(repo)).some((choice) => choice.name === 'origin/HEAD')).toBe(false);
  });

  it('says when the upstream is gone, and keeps subjects with unusual characters whole', async () => {
    await local.git('checkout', '-q', '-b', 'feature', '--track', 'origin/remote-only');
    await origin.git('branch', '-D', 'remote-only');
    await local.git('fetch', '-q', '--prune', 'origin');
    await local.commit('tabs\tand %(refname) here');

    const feature = (await branchChoices(repo)).find((choice) => choice.name === 'feature');
    expect(feature).toMatchObject({ gone: true, subject: 'tabs\tand %(refname) here' });
  });

  it('lists branches checked out recently, newest first, without the current one or detached commits', async () => {
    await local.branch('a');
    await local.branch('b');
    await local.checkout('a');
    await local.checkout('b');
    await local.checkout('HEAD~0^{commit}'); // detached
    await local.checkout('a');
    await local.checkout('main');

    expect(await recentBranches(repo)).toEqual(['a', 'b']);
    expect(await recentBranches(repo, 1)).toEqual(['a']);
  });

  it('has no recent branches in a repository without commits', async () => {
    const empty = await TestRepo.create();
    try {
      const emptyRepo = (await Repository.open(empty.runner, empty.path))!;
      expect(await recentBranches(emptyRepo)).toEqual([]);
      expect(await headStatus(emptyRepo)).toEqual({
        branch: 'main',
        sha: undefined,
        upstream: undefined,
        ahead: 0,
        behind: 0,
      });
    } finally {
      await empty.dispose();
    }
  });

  it('reports the checked-out branch against its upstream, and a detached HEAD', async () => {
    expect(await headStatus(repo)).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    });
    await local.commits('one', 'two');
    await origin.commit('theirs');
    await local.git('fetch', '-q', 'origin');
    expect(await headStatus(repo)).toMatchObject({ branch: 'main', ahead: 2, behind: 1 });

    const sha = await local.rev('HEAD');
    await local.checkout(sha);
    expect(await headStatus(repo)).toEqual({
      branch: undefined,
      sha,
      upstream: undefined,
      ahead: 0,
      behind: 0,
    });
  });

  it('tells whether there are untracked files, ignored ones aside', async () => {
    expect(await hasUntrackedFiles(repo)).toBe(false);
    await local.write('.gitignore', 'build/\n');
    await local.write('build/out.txt', 'x');
    await local.git('add', '.gitignore');
    expect(await hasUntrackedFiles(repo)).toBe(false);
    await local.write('notes.txt', 'x');
    expect(await hasUntrackedFiles(repo)).toBe(true);
  });
});
