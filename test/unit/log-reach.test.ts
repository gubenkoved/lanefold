import { describe, expect, it } from 'vitest';
import type { HeadInfo, RefInfo } from '../../src/shared/models';
import {
  containsCommits,
  editBlocker,
  headContains,
  lastMerge,
  type HistoryGraph,
} from '../../src/webview/views/log/reach';
import { buildTopology, fakeOid, type CommitSpec } from './graph-helpers';

/*
 * main (m3 m2 m1) on top of a merge (mg) of a side branch (s1) into the trunk (t1), then the
 * root. feature/x (f2 f1) branches off m1; origin/feature/y (y1) off m2.
 */
const HISTORY: CommitSpec[] = [
  ['m3', ['m2']],
  ['y1', ['m2']],
  ['f2', ['f1']],
  ['m2', ['m1']],
  ['f1', ['m1']],
  ['m1', ['mg']],
  ['mg', ['t1', 's1']],
  ['t1', ['root']],
  ['s1', ['root']],
  ['root', []],
];

const sha = fakeOid;

function ref(short: string, target: string, kind: RefInfo['kind'] = 'branch', isHead = false): RefInfo {
  const prefix = kind === 'branch' ? 'refs/heads/' : kind === 'remote' ? 'refs/remotes/' : 'refs/tags/';
  return { name: `${prefix}${short}`, short, kind, target: sha(target), isHead };
}

const REFS: RefInfo[] = [
  ref('main', 'm3', 'branch', true),
  ref('feature/x', 'f2'),
  ref('origin/feature/y', 'y1', 'remote'),
  ref('origin/main', 'm2', 'remote'),
  ref('v1', 'm1', 'tag'),
];

function graph(
  options: { head?: Partial<HeadInfo>; refs?: RefInfo[]; history?: CommitSpec[] } = {},
): HistoryGraph {
  const { topo } = buildTopology(options.history ?? HISTORY);
  const head: HeadInfo = { branch: 'main', sha: sha('m3'), detached: false, unborn: false, ...options.head };
  return { topology: topo, refs: { refs: options.refs ?? REFS, head } };
}

/** What the history editor reaches from m3: back to the merge (as entryPoints' editableHistory). */
const EDITABLE = new Map([sha('m3'), sha('m2'), sha('m1')].map((s, distance) => [s, distance]));

describe('containsCommits', () => {
  const g = graph();
  const containsCommit = (tip: string, sha: string) => containsCommits(g, tip, [sha]);

  it('follows every parent down, merged sides too', () => {
    expect(containsCommit(sha('m3'), sha('m3'))).toBe(true);
    expect(containsCommit(sha('m3'), sha('m1'))).toBe(true);
    expect(containsCommit(sha('m3'), sha('t1'))).toBe(true);
    expect(containsCommit(sha('m3'), sha('s1'))).toBe(true);
    expect(containsCommit(sha('m3'), sha('root'))).toBe(true);
  });

  it('says no for other branches and for newer commits', () => {
    expect(containsCommit(sha('m3'), sha('f1'))).toBe(false);
    expect(containsCommit(sha('m3'), sha('y1'))).toBe(false);
    expect(containsCommit(sha('f2'), sha('m3'))).toBe(false);
    expect(containsCommit(sha('m1'), sha('m2'))).toBe(false);
  });

  it('cannot tell for commits not loaded, or a way down that leaves the history', () => {
    expect(containsCommit(sha('m3'), sha('elsewhere'))).toBeUndefined();
    const cut = graph({
      history: [
        ['a', ['gone']],
        ['b', []],
      ],
    });
    expect(containsCommits(cut, sha('a'), [sha('b')])).toBeUndefined();
  });

  it('answers for several commits at once: all of them', () => {
    expect(containsCommits(g, sha('m3'), [sha('m1'), sha('s1'), sha('root')])).toBe(true);
    expect(containsCommits(g, sha('m3'), [sha('m1'), sha('f1')])).toBe(false);
    expect(containsCommits(g, sha('m3'), [])).toBe(true);
    expect(headContains(graph(), [sha('m2'), sha('t1')])).toBe(true);
  });

  it('reads a filtered model through its source', () => {
    const filtered: HistoryGraph = { ...graph({ history: [['m3', []]] }), source: g };
    expect(containsCommits(filtered, sha('m3'), [sha('s1')])).toBe(true);
  });
});

describe('headContains and lastMerge', () => {
  it('ask from HEAD', () => {
    expect(headContains(graph(), sha('root'))).toBe(true);
    expect(headContains(graph(), sha('f2'))).toBe(false);
    expect(headContains(graph({ head: { sha: sha('f2'), branch: 'feature/x' } }), sha('f1'))).toBe(true);
    expect(lastMerge(graph())).toBe(sha('mg'));
    expect(lastMerge(graph({ head: { sha: sha('f2') } }))).toBe(sha('mg'));
  });

  it('an unborn branch has nothing yet', () => {
    const unborn = graph({ head: { sha: undefined, unborn: true } });
    expect(headContains(unborn, sha('m3'))).toBe(false);
    expect(lastMerge(unborn)).toBeUndefined();
  });

  it('a line without merges has none', () => {
    const line = graph({
      history: [
        ['m3', ['m2']],
        ['m2', []],
      ],
    });
    expect(lastMerge(line)).toBeUndefined();
  });
});

describe('editBlocker', () => {
  const g = graph();

  it('lets the editor have what it reaches', () => {
    expect(editBlocker(g, sha('m2'), EDITABLE)).toBeUndefined();
  });

  it('says where editing stops on the current branch', () => {
    expect(editBlocker(g, sha('t1'), EDITABLE)).toBe(
      `Editing reaches back to the last merge, ${sha('mg').slice(0, 8)}`,
    );
    expect(editBlocker(g, sha('s1'), EDITABLE, 'amend')).toBe(
      `Amending reaches back to the last merge, ${sha('mg').slice(0, 8)}`,
    );
    expect(editBlocker(g, sha('mg'), EDITABLE)).toBe('Merge commits can’t be edited here');
  });

  it('names the branch to check out for commits elsewhere, local ones first', () => {
    expect(editBlocker(g, sha('f1'), EDITABLE)).toBe('Check out feature/x to edit it');
    expect(editBlocker(g, sha('f1'), EDITABLE, 'amend')).toBe('Check out feature/x to amend it');
    expect(editBlocker(g, sha('y1'), EDITABLE)).toBe('Check out origin/feature/y to edit it');
    const both = graph({ refs: [...REFS, ref('origin/feature/x', 'f2', 'remote')] });
    expect(editBlocker(both, sha('f1'), EDITABLE)).toBe('Check out feature/x to edit it');
  });

  it('falls back to what can be edited when it knows no better', () => {
    expect(editBlocker(g, sha('elsewhere'), EDITABLE)).toBe(
      'Only commits of main since its last merge can be edited',
    );
    expect(editBlocker(graph({ head: { sha: undefined, unborn: true } }), sha('m3'), new Map())).toBe(
      'main has no commits yet',
    );
  });
});
