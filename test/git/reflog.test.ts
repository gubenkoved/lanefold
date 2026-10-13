import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReflog } from '../../src/core/repo/reflog';
import { Repository } from '../../src/core/repo/repository';
import { TestRepo } from '../fixtures/repoBuilder';

describe('reflog (real git)', () => {
  let test: TestRepo;
  let repo: Repository;

  beforeEach(async () => {
    test = await TestRepo.create();
    repo = (await Repository.open(test.runner, test.path))!;
  });

  afterEach(async () => {
    await test.dispose();
  });

  it('is empty before the first commit', async () => {
    expect(await readReflog(repo, 100)).toEqual([]);
  });

  it('lists where HEAD has been and marks commits only the reflog still has', async () => {
    await test.commits('one', 'two');
    const doomed = await test.commit('doomed work');
    await test.git('reset', '-q', '--hard', 'HEAD~1');
    await test.checkoutNew('topic');

    const entries = await readReflog(repo, 100);
    expect(entries.map((e) => [e.action, e.subject])).toEqual([
      ['checkout', 'two'],
      ['reset', 'two'],
      ['commit', 'doomed work'],
      ['commit', 'two'],
      ['commit (initial)', 'one'],
    ]);
    expect(entries.filter((e) => e.lost).map((e) => e.sha)).toEqual([doomed]);
    expect(entries[0]!.detail).toBe('moving from main to topic');
    expect((await readReflog(repo, 2)).length).toBe(2);
  });

  it('numbers the entries as git does, and dates them when HEAD moved', async () => {
    await test.commits('one', 'two');
    // Renaming the branch HEAD is on notes something git does not show, but counts.
    await test.git('branch', '-m', 'main', 'trunk');
    await test.commit('three');
    test.at('2030-01-01');
    await test.git('checkout', '-q', 'HEAD~1');

    const entries = await readReflog(repo, 100);
    const numbers = (await test.git('log', '-g', '--format=%gd')).split('\n');
    expect(entries.map((entry) => `HEAD@{${entry.index}}`)).toEqual(numbers);
    expect(entries.map((entry) => entry.index)).not.toEqual(entries.map((_, position) => position));
    for (const entry of entries) expect(await test.rev(`HEAD@{${entry.index}}`)).toBe(entry.sha);
    // When HEAD moved there, not when the commit was made.
    expect(entries[0]!.time).toBe(Date.parse('2030-01-01T10:00:00Z') / 1000);
    expect(entries[1]!.time).toBe(Number(await test.git('log', '-1', '--format=%ct', 'trunk')));
  });
});
