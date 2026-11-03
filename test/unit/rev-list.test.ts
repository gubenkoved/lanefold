import { describe, expect, it } from 'vitest';
import { preloadTips, revListArgs } from '../../src/core/log/revList';
import type { RefInfo, RefsSnapshot } from '../../src/shared/models';

const DAY = 24 * 3600;
const NOW = 1_800_000_000;
const sha = (n: number) => n.toString(16).padStart(40, '0');

function snapshot(refs: Partial<RefInfo>[], headSha = sha(1)): RefsSnapshot {
  return {
    head: { branch: 'main', sha: headSha, detached: false, unborn: false },
    refs: refs.map((ref, i) => ({
      name: `refs/heads/r${i}`,
      short: `r${i}`,
      kind: 'branch',
      target: sha(100 + i),
      date: NOW,
      ...ref,
    })),
  };
}

describe('preloadTips', () => {
  const all = { scope: { type: 'all' } } as const;

  it('starts from recent refs and HEAD when old refs exist', () => {
    const refs = snapshot([
      { target: sha(2), date: NOW },
      { target: sha(3), date: NOW - 10 * DAY },
      { kind: 'tag', target: sha(4), date: NOW - 900 * DAY },
    ]);
    expect(preloadTips(all, refs)?.sort()).toEqual([sha(1), sha(2), sha(3)].sort());
  });

  it('is not used when every ref is recent, for other scopes, or without dates', () => {
    expect(preloadTips(all, snapshot([{ date: NOW }, { date: NOW - DAY }]))).toBeUndefined();
    expect(
      preloadTips({ scope: { type: 'head' } }, snapshot([{ date: NOW }, { date: 0 + 1 }])),
    ).toBeUndefined();
    expect(preloadTips(all, snapshot([{ date: NOW }, { date: undefined }]))).toBeUndefined();
  });

  it('only considers branches for the local scope', () => {
    const refs = snapshot([
      { target: sha(2), date: NOW },
      { target: sha(3), date: NOW },
      { kind: 'tag', target: sha(4), date: NOW - 900 * DAY },
    ]);
    // The old tag is not part of a local view, so every branch is recent: no preload needed.
    expect(preloadTips({ scope: { type: 'local' } }, refs)).toBeUndefined();
  });
});

describe('revListArgs with tips', () => {
  const head = { branch: 'main', sha: sha(1), detached: false, unborn: false };

  it('feeds the starting commits through stdin', () => {
    const query = revListArgs({ scope: { type: 'all' }, firstParent: true }, head, 'topo', {
      tips: [sha(1), sha(2)],
    });
    expect(query.args).toEqual(['rev-list', '--parents', '--topo-order', '--first-parent', '--stdin']);
    expect(query.stdin).toBe(`${sha(1)}\n${sha(2)}\n`);
  });

  it('ignores tips for explicit ref scopes and rejects anything but object IDs', () => {
    const query = revListArgs({ scope: { type: 'refs', refs: ['main'] } }, head, 'topo', { tips: [sha(1)] });
    expect(query.stdin).toBeUndefined();
    expect(query.args).toContain('main');
    expect(() => revListArgs({ scope: { type: 'all' } }, head, 'topo', { tips: ['--all'] })).toThrow();
  });
});

describe('hidden refs', () => {
  const head = { branch: 'main', sha: sha(1), detached: false, unborn: false };

  it('excludes hidden branches, remote branches and tags from the matching ref option', () => {
    const { args } = revListArgs(
      {
        scope: { type: 'all' },
        hidden: ['refs/heads/feature/x', 'refs/remotes/origin/old', 'refs/tags/v0.1', 'refs/heads/bad*glob'],
      },
      head,
      'topo',
    );
    expect(args).toEqual([
      'rev-list',
      '--parents',
      '--topo-order',
      '--exclude=feature/x',
      '--branches',
      '--exclude=origin/old',
      '--remotes',
      '--exclude=v0.1',
      '--tags',
      '--end-of-options',
      'HEAD',
    ]);
    expect(
      revListArgs({ scope: { type: 'local' }, hidden: ['refs/heads/wip', 'refs/tags/v1'] }, head, 'topo')
        .args,
    ).toEqual([
      'rev-list',
      '--parents',
      '--topo-order',
      '--exclude=wip',
      '--branches',
      '--end-of-options',
      'HEAD',
    ]);
  });

  it('leaves hidden refs out of the fast first load', () => {
    const refs = snapshot([
      { name: 'refs/heads/new', target: sha(2), date: NOW },
      { name: 'refs/heads/hidden', target: sha(3), date: NOW },
      { name: 'refs/heads/old', target: sha(4), date: NOW - 900 * DAY },
    ]);
    expect(preloadTips({ scope: { type: 'all' }, hidden: ['refs/heads/hidden'] }, refs)?.sort()).toEqual(
      [sha(1), sha(2)].sort(),
    );
  });
});

describe('refs shown besides a view’s own', () => {
  const head = { branch: 'main', sha: sha(1), detached: false, unborn: false };

  it('adds them to the current branch and to the local branches', () => {
    const extra = ['refs/heads/main', 'refs/remotes/origin/feature', 'refs/tags/v1.0'];
    expect(revListArgs({ scope: { type: 'head' }, extra }, head, 'topo').args).toEqual([
      'rev-list',
      '--parents',
      '--topo-order',
      '--end-of-options',
      'HEAD',
      ...extra,
    ]);
    expect(
      revListArgs({ scope: { type: 'local' }, hidden: ['refs/heads/wip'], extra }, head, 'topo').args,
    ).toEqual([
      'rev-list',
      '--parents',
      '--topo-order',
      '--exclude=wip',
      '--branches',
      '--end-of-options',
      'HEAD',
      ...extra,
    ]);
  });

  it('shows them without a first commit of its own, and takes ref names only', () => {
    const unborn = { branch: 'main', detached: false, unborn: true };
    expect(revListArgs({ scope: { type: 'head' } }, unborn, 'topo').args).toBeUndefined();
    expect(
      revListArgs({ scope: { type: 'head' }, extra: ['refs/heads/other'] }, unborn, 'topo').args,
    ).toEqual(['rev-list', '--parents', '--topo-order', '--end-of-options', 'refs/heads/other']);
    expect(
      revListArgs({ scope: { type: 'head' }, extra: ['--all', 'HEAD~2', 'refs/heads/a*'] }, head, 'topo')
        .args,
    ).toEqual(['rev-list', '--parents', '--topo-order', '--end-of-options', 'HEAD']);
  });

  it('counts them in the fast first load of local branches', () => {
    const refs = snapshot([
      { name: 'refs/heads/new', target: sha(2), date: NOW },
      { name: 'refs/heads/old', target: sha(3), date: NOW - 900 * DAY },
      { name: 'refs/remotes/origin/new', kind: 'remote', target: sha(4), date: NOW },
      { name: 'refs/tags/v0.1', kind: 'tag', target: sha(5), date: NOW },
    ]);
    const tips = preloadTips({ scope: { type: 'local' }, extra: ['refs/remotes/origin/new'] }, refs);
    expect(tips?.sort()).toEqual([sha(1), sha(2), sha(4)].sort());
  });
});

describe('line history', () => {
  const head = { branch: 'main', sha: sha(1), detached: false, unborn: false };

  it('follows lines with git log -L on the current branch, parents rewritten', () => {
    expect(
      revListArgs({ scope: { type: 'all' }, lines: { path: 'src/a b.ts', start: 3, end: 9 } }, head, 'topo')
        .args,
    ).toEqual([
      'log',
      '--format=%H %P',
      '--parents',
      '-s',
      '--topo-order',
      '-L3,9:src/a b.ts',
      '--end-of-options',
      'HEAD',
    ]);
    expect(
      revListArgs(
        { scope: { type: 'refs', refs: ['v1.0'] }, lines: { path: 'x', start: 1, end: 1 } },
        head,
        'date',
      ).args,
    ).toEqual([
      'log',
      '--format=%H %P',
      '--parents',
      '-s',
      '--date-order',
      '-L1,1:x',
      '--end-of-options',
      'v1.0',
    ]);
  });

  it('refuses malformed ranges', () => {
    expect(() =>
      revListArgs({ scope: { type: 'head' }, lines: { path: 'x', start: 5, end: 2 } }, head, 'topo'),
    ).toThrow();
  });
});
