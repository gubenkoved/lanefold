import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitCommandStart } from '../../src/core/git/runner';
import { RepoOperations } from '../../src/core/ops/operations';
import { REFS_FAST_FORMAT, REFS_FORMAT } from '../../src/core/parsers/refs';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import { TestRepo } from '../fixtures/repoBuilder';

describe('reading large repositories (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let data: RepoData;
  let started: GitCommandStart[];

  beforeEach(async () => {
    started = [];
    test = await TestRepo.create({
      runnerOptions: { listener: { onCommandStart: (event) => started.push(event) } },
    });
    await test.commits('one', 'two', 'three');
    repo = (await Repository.open(test.runner, test.path))!;
    data = new RepoData(repo);
  });

  afterEach(async () => {
    data.dispose();
    await test.dispose();
  });

  /** Refs as a new RepoData reads them (every object opened by for-each-ref). */
  async function freshRefs() {
    const fresh = new RepoData(repo);
    try {
      return await fresh.refs();
    } finally {
      fresh.dispose();
    }
  }

  /** The formats of the for-each-ref reads since `started` was cleared. */
  const refReads = () =>
    started
      .filter((event) => event.args.includes('for-each-ref'))
      .map((event) => event.args.find((arg) => arg.startsWith('--format=')));

  it('remembers what ref objects say, and later reads match a full read exactly', async () => {
    await test.tag('v1', { message: 'Release 1' });
    await test.tag('light');
    await test.branch('feature', 'HEAD~1');
    expect(await data.refs()).toEqual(await freshRefs());

    // New, moved and deleted refs: annotated and lightweight tags, a branch on a new commit.
    await test.commit('four');
    await test.tag('v2', { message: 'Release 2' });
    await test.git('branch', '-f', 'feature', 'HEAD');
    await test.git('tag', '-d', 'light');
    started.length = 0;
    const warm = await data.refs();
    // Listed without opening objects; only the new ones were read.
    expect(refReads()).toEqual([`--format=${REFS_FAST_FORMAT}`]);
    expect(warm).toEqual(await freshRefs());
    expect(warm.refs.map((ref) => ref.short).sort()).toEqual(['feature', 'main', 'v1', 'v2']);
    expect(warm.refs.find((ref) => ref.short === 'v2')).toMatchObject({
      annotated: true,
      target: await test.rev('HEAD'),
    });
  });

  it('opens every object once when views read refs together', async () => {
    await test.tag('v1', { message: 'Release 1' });
    started.length = 0;
    const [first, second] = await Promise.all([data.refs(), data.refs()]);
    expect(second).toEqual(first);
    // One full read; the other waited for it, then listed the refs without opening objects.
    expect(refReads().sort()).toEqual([`--format=${REFS_FAST_FORMAT}`, `--format=${REFS_FORMAT}`].sort());
  });

  it('reads only the new objects when refs move, and every object when hundreds are new', async () => {
    await data.refs();
    // Many refs to one commit the cache does not know: one object to read.
    const two = await test.rev('HEAD~1');
    const tags = Array.from({ length: 400 }, (_, i) => `create refs/tags/build-${i} ${two}`);
    await test.runner.run({ cwd: test.path, args: ['update-ref', '--stdin'], stdin: `${tags.join('\n')}\n` });
    started.length = 0;
    expect((await data.refs()).refs).toHaveLength(401);
    expect(refReads()).toEqual([`--format=${REFS_FAST_FORMAT}`]);

    // 350 new commits, each tagged (a fetch from a busy remote, say): one full read is quicker.
    const stream = Array.from(
      { length: 350 },
      (_, i) =>
        `commit refs/heads/many\nmark :${i + 1}\ncommitter T <t@example.com> ${1_704_100_000 + i} +0000\ndata 2\nc\n\n` +
        `reset refs/tags/many-${i}\nfrom :${i + 1}\n\n`,
    ).join('');
    await test.runner.run({ cwd: test.path, args: ['fast-import', '--quiet'], stdin: stream });
    started.length = 0;
    const refs = await data.refs();
    expect(refReads()).toHaveLength(2);
    expect(refs).toEqual(await freshRefs());
    expect(refs.refs).toHaveLength(752);
  });

  it('Undo writes back only the files that differ: the others keep their timestamps', async () => {
    await test.commit('files', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'dir/c.txt': 'c\n' } });
    await writeFile(join(test.path, 'a.txt'), 'a edited\n');
    await writeFile(join(test.path, 'new.txt'), 'new\n');
    const ops = new RepoOperations(repo, data);
    try {
      const plan = await ops.plan({ kind: 'reset', to: 'HEAD', mode: 'hard' });
      expect((await ops.execute(plan.id)).status).toBe('done');
      expect(await readFile(join(test.path, 'a.txt'), 'utf8')).toBe('a\n');
      // An hour ago, in whole seconds (they read back exactly): anything Undo rewrites gets a new time.
      const past = new Date(Math.floor(Date.now() / 1000 - 3600) * 1000);
      for (const path of ['a.txt', 'b.txt', 'dir/c.txt']) await utimes(join(test.path, path), past, past);

      expect((await ops.undo()).status).toBe('done');
      expect(await readFile(join(test.path, 'a.txt'), 'utf8')).toBe('a edited\n');
      expect(await readFile(join(test.path, 'new.txt'), 'utf8')).toBe('new\n');
      const time = async (path: string) => (await stat(join(test.path, path))).mtimeMs;
      expect(await time('b.txt')).toBe(past.getTime());
      expect(await time('dir/c.txt')).toBe(past.getTime());
      expect(await time('a.txt')).toBeGreaterThan(past.getTime());
      expect(await test.git('status', '--porcelain')).toBe(' M a.txt\n?? new.txt');
    } finally {
      ops.dispose();
    }
  });

  it('lets views share a status read in progress, until the repository changes', async () => {
    await writeFile(join(test.path, 'new.txt'), 'new\n');
    const statusReads = () => started.filter((event) => event.args.includes('status')).length;
    started.length = 0;
    const [tree, changes] = await Promise.all([
      data.workingTree({ shared: true }),
      data.worktreeChanges({ shared: true }),
    ]);
    expect(tree.untracked).toBe(1);
    expect(changes.untracked.map((file) => file.path)).toEqual(['new.txt']);
    expect(statusReads()).toBe(1);

    // A reported change ends the sharing: the next read starts afresh and sees it.
    const before = data.workingTree({ shared: true });
    await writeFile(join(test.path, 'other.txt'), 'other\n');
    data.changed();
    const after = data.workingTree({ shared: true });
    expect((await after).untracked).toBe(2);
    await before;
    expect(statusReads()).toBe(3);

    // Operations never share a read.
    await Promise.all([data.workingTree(), data.workingTree()]);
    expect(statusReads()).toBe(5);
  });

  it('lets views share ref, HEAD and remote reads in progress, until the repository changes', async () => {
    const refReads = () => started.filter((event) => event.args.includes('for-each-ref')).length;
    started.length = 0;
    const [refs, sameRefs, head, sameHead, remotes, sameRemotes] = await Promise.all([
      data.refs({ shared: true }),
      data.refs({ shared: true }),
      data.head({ shared: true }),
      data.head({ shared: true }),
      data.remotes({ shared: true }),
      data.remotes({ shared: true }),
    ]);
    expect(sameRefs).toBe(refs);
    expect(sameHead).toBe(head);
    expect(sameRemotes).toBe(remotes);
    expect(refReads()).toBe(1);

    // A reported change ends the sharing; operations never share.
    const before = data.refs({ shared: true });
    data.changed();
    expect(await data.refs({ shared: true })).not.toBe(await before);
    const [first, second] = await Promise.all([data.refs(), data.refs()]);
    expect(second).not.toBe(first);
    expect(refReads()).toBe(5);
  });
});
