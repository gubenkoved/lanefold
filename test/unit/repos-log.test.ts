import { describe, expect, it } from 'vitest';
import { mergedRevList, reposLogView } from '../../src/core/backend/reposLog';
import { filterTopology } from '../../src/shared/graph/filter';
import { GraphTopology } from '../../src/shared/graph/topology';
import type { RefInfo, RefsSnapshot } from '../../src/shared/models';
import { objectStores } from '../../src/shared/repoGroups';
import { fakeOid } from './graph-helpers';

describe('objectStores', () => {
  it('groups the linked worktrees of a repository by their common git directory, in order', () => {
    const repos = [
      { id: 'a', commonDir: '/w/aurora/.git' },
      { id: 'b', commonDir: '/w/nimbus/.git' },
      { id: 'a2', commonDir: '/w/aurora/.git/' },
      { id: 'c', commonDir: 'C:\\w\\Zephyr\\.git' },
      { id: 'c2', commonDir: 'c:/w/zephyr/.git' },
      { id: 'd', commonDir: '/w/Zephyr/.git' },
    ];
    expect(objectStores(repos).map((group) => group.map((repo) => repo.id))).toEqual([
      ['a', 'a2'],
      ['b'],
      ['c', 'c2'],
      // POSIX paths keep their case.
      ['d'],
    ]);
  });
});

describe('rows of a log of several repositories', () => {
  it('keep their repository through chunks and filters', () => {
    const topo = new GraphTopology(20);
    const [a, b, c] = ['a', 'b', 'c'].map((name) => topo.addOidHex(fakeOid(name))) as [
      number,
      number,
      number,
    ];
    const chunk = { logId: 1, firstNewId: 3, newOids: new Uint8Array(0) };
    topo.appendChunk({
      ...chunk,
      startRow: 0,
      rowIds: Int32Array.of(a, b),
      parentStart: Uint32Array.of(0, 1, 1),
      parentIds: Int32Array.of(c),
      repos: Uint16Array.of(0, 1),
    });
    topo.appendChunk({
      ...chunk,
      startRow: 2,
      rowIds: Int32Array.of(c),
      parentStart: Uint32Array.of(0, 0),
      parentIds: new Int32Array(0),
      repos: Uint16Array.of(2),
    });
    expect(topo.hasRowRepos).toBe(true);
    expect([0, 1, 2].map((row) => topo.rowRepo(row))).toEqual([0, 1, 2]);
    const filtered = filterTopology(topo, Uint8Array.of(1, 0, 1));
    expect([0, 1].map((row) => filtered.rowRepo(row))).toEqual([0, 2]);
  });

  it('are all of the one repository in a repository’s own log', () => {
    const topo = new GraphTopology(20);
    topo.appendRow(topo.addOidHex(fakeOid('a')), []);
    expect(topo.hasRowRepos).toBe(false);
    expect(topo.rowRepo(0)).toBe(0);
  });
});

describe('the rev-list of each repository', () => {
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  const head = { branch: 'main', sha: sha(1), detached: false, unborn: false };
  const refs: RefsSnapshot = { head, refs: [] };

  it('lists commits by date with their timestamps, other worktrees’ HEADs through --stdin', () => {
    expect(mergedRevList(reposLogView({ scope: { type: 'all' } }), refs, [], true)).toEqual({
      args: [
        'rev-list',
        '--timestamp',
        '--parents',
        '--date-order',
        '--branches',
        '--remotes',
        '--tags',
        '--end-of-options',
        'HEAD',
      ],
      stdin: undefined,
      partial: false,
    });
    const linked = mergedRevList(
      reposLogView({ scope: { type: 'head' }, firstParent: true }),
      refs,
      [sha(2)],
      true,
    );
    expect(linked?.args).toEqual([
      'rev-list',
      '--timestamp',
      '--stdin',
      '--parents',
      '--date-order',
      '--first-parent',
      '--end-of-options',
      'HEAD',
    ]);
    expect(linked?.stdin).toBe(`${sha(2)}\n`);
  });

  it('starts from the recent refs for a fast first load', () => {
    const DAY = 24 * 3600;
    const ref = (n: number, date: number): RefInfo => ({
      name: `refs/heads/b${n}`,
      short: `b${n}`,
      kind: 'branch',
      target: sha(n),
      date,
    });
    const old: RefsSnapshot = { head, refs: [ref(2, 1_800_000_000), ref(3, 1_800_000_000 - 400 * DAY)] };
    const query = mergedRevList(reposLogView({ scope: { type: 'all' } }), old, [sha(9)], false);
    expect(query?.partial).toBe(true);
    expect(query?.args.slice(0, 2)).toEqual(['rev-list', '--timestamp']);
    expect(query?.stdin?.split('\n').filter(Boolean).sort()).toEqual([sha(1), sha(2), sha(9)].sort());
  });

  it('has nothing to list for a repository without commits on its current branch', () => {
    const unborn: RefsSnapshot = { head: { branch: 'main', detached: false, unborn: true }, refs: [] };
    expect(mergedRevList(reposLogView({ scope: { type: 'head' } }), unborn, [], true)).toBeUndefined();
  });

  it('accepts only the views it can merge', () => {
    expect(() => reposLogView({ scope: { type: 'refs', refs: ['main'] } })).toThrow(/all, local or current/);
    expect(() => reposLogView(undefined)).toThrow();
    expect(reposLogView({ scope: { type: 'local' }, paths: ['x'], firstParent: 'yes' })).toEqual({
      scope: { type: 'local' },
      order: 'date',
      firstParent: false,
      noMerges: false,
    });
  });
});
