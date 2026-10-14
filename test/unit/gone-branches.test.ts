import { describe, expect, it } from 'vitest';
import type { RefInfo } from '../../src/shared/models';
import { goneBranches, remoteOfName } from '../../src/webview/views/log/upstreams';

const branch = (short: string, upstream?: string, more: Partial<RefInfo> = {}): RefInfo => ({
  name: `refs/heads/${short}`,
  short,
  kind: 'branch',
  target: 'a'.repeat(40),
  upstream,
  ...more,
});

const REFS: RefInfo[] = [
  branch('main', 'origin/main'),
  branch('done', 'origin/done', { gone: true }),
  branch('fix', 'team/ci/fix', { gone: true }),
  branch('idea', 'team/idea', { gone: true }),
  branch('local-only'),
  branch('current', 'origin/current', { gone: true, isHead: true }),
  { name: 'refs/remotes/origin/main', short: 'origin/main', kind: 'remote', target: 'b'.repeat(40) },
];

const names = (refs: readonly RefInfo[]) => refs.map((ref) => ref.short);

describe('upstreams of branches', () => {
  it('names a remote branch’s remote by the longest remote name it starts with', () => {
    const remotes = ['origin', 'team', 'team/ci'];
    expect(remoteOfName('team/ci/fix', remotes)).toBe('team/ci');
    expect(remoteOfName('team/idea', remotes)).toBe('team');
    expect(remoteOfName('upstream/main', remotes)).toBeUndefined();
  });

  it('finds the local branches whose upstream is gone, of one remote when asked', () => {
    const remotes = ['origin', 'team', 'team/ci'];
    expect(names(goneBranches(REFS, remotes))).toEqual(['done', 'fix', 'idea', 'current']);
    expect(names(goneBranches(REFS, remotes, 'origin'))).toEqual(['done', 'current']);
    expect(names(goneBranches(REFS, remotes, 'team'))).toEqual(['idea']);
    expect(names(goneBranches(REFS, remotes, 'team/ci'))).toEqual(['fix']);
    expect(goneBranches(REFS, remotes, 'upstream')).toEqual([]);
    // Remotes not known yet: an upstream's remote is what precedes its first “/”.
    expect(names(goneBranches(REFS, [], 'team'))).toEqual(['fix', 'idea']);
  });
});
