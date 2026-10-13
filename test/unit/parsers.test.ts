import { describe, expect, it } from 'vitest';
import { bodyOf, parseCommit, parseIdent, subjectOf } from '../../src/core/parsers/commit';
import { parseRawNumstat } from '../../src/core/parsers/diff';
import { parseRefs, pickTrunk } from '../../src/core/parsers/refs';
import { parseStatus, summarizeStatus } from '../../src/core/parsers/status';

const enc = (text: string) => new TextEncoder().encode(text);

describe('parseCommit', () => {
  it('parses headers, skips multi-line signatures and splits the message', () => {
    const raw = enc(
      [
        'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        'parent 1111111111111111111111111111111111111111',
        'parent 2222222222222222222222222222222222222222',
        'author Jane Doe <jane@example.com> 1700000000 +0200',
        'committer CI Bot <ci@example.com> 1700000100 -0500',
        'gpgsig -----BEGIN SSH SIGNATURE-----',
        ' U1NIU0lHAAAAAQ==',
        ' -----END SSH SIGNATURE-----',
        '',
        'Merge feature: add login',
        '',
        'Long body line 1',
        'Line 2',
        '',
      ].join('\n'),
    );
    const commit = parseCommit(raw);
    expect(commit.parents).toEqual(['1'.repeat(40), '2'.repeat(40)]);
    expect(commit.author).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      time: 1700000000,
      tz: '+0200',
    });
    expect(commit.committer.name).toBe('CI Bot');
    expect(commit.signed).toBe(true);
    expect(subjectOf(commit.message)).toBe('Merge feature: add login');
    expect(bodyOf(commit.message)).toBe('Long body line 1\nLine 2');
  });

  it('decodes messages in a declared legacy encoding', () => {
    const header = enc(
      'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor J <j@x> 1 +0000\ncommitter J <j@x> 1 +0000\nencoding ISO-8859-1\n\n',
    );
    const body = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in Latin-1
    const raw = new Uint8Array(header.length + body.length);
    raw.set(header);
    raw.set(body, header.length);
    const commit = parseCommit(raw);
    expect(commit.message).toBe('Café');
    expect(commit.signed).toBe(false);
  });

  it('tolerates odd identities', () => {
    expect(parseIdent('<nobody@x> 5 +0000')).toEqual({ name: '', email: 'nobody@x', time: 5, tz: '+0000' });
    expect(parseIdent('garbage').name).toBe('garbage');
  });
});

describe('parseRefs / pickTrunk', () => {
  const lines = [
    ['refs/heads/main', 'commit', 'a'.repeat(40), '', 'origin/main', 'ahead 2, behind 1', '*', ''],
    ['refs/heads/topic', 'commit', 'b'.repeat(40), '', 'origin/topic', 'gone', ' ', ''],
    ['refs/heads/local-only', 'commit', 'c'.repeat(40), '', '', '', ' ', ''],
    ['refs/remotes/origin/HEAD', 'commit', 'a'.repeat(40), '', '', '', ' ', 'refs/remotes/origin/main'],
    ['refs/remotes/origin/main', 'commit', 'd'.repeat(40), '', '', '', ' ', ''],
    ['refs/tags/v1', 'tag', 'e'.repeat(40), 'f'.repeat(40), '', '', ' ', ''],
    ['refs/tags/light', 'commit', '1'.repeat(40), '', '', '', ' ', ''],
    ['refs/tags/tree-tag', 'tree', '2'.repeat(40), '', '', '', ' ', ''],
  ]
    .map((fields) => fields.join('\0'))
    .join('\n');

  it('parses branches, remotes and tags (peeling annotated tags)', () => {
    const refs = parseRefs(lines);
    expect(refs.map((r) => `${r.kind}:${r.short}`)).toEqual([
      'branch:main',
      'branch:topic',
      'branch:local-only',
      'remote:origin/main',
      'tag:v1',
      'tag:light',
    ]);
    expect(refs[0]).toMatchObject({ isHead: true, upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(refs[1]).toMatchObject({ gone: true });
    expect(refs[2]?.upstream).toBeUndefined();
    expect(refs[3]).toMatchObject({ remote: 'origin' });
    expect(refs[4]).toMatchObject({ target: 'f'.repeat(40), annotated: true });
  });

  it('picks the trunk', () => {
    const refs = parseRefs(lines);
    expect(pickTrunk(refs, 'origin/main')).toBe('main');
    expect(
      pickTrunk(
        refs.filter((r) => r.short !== 'main'),
        'origin/main',
      ),
    ).toBe('origin/main');
    expect(
      pickTrunk(
        refs.filter((r) => r.short !== 'main'),
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe('parseStatus', () => {
  it('parses porcelain v2 records including renames and conflicts', () => {
    const output = [
      '# branch.oid abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +1 -2',
      '# stash 3',
      '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
      '1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked.txt',
      '',
    ].join('\0');
    const status = parseStatus(output);
    expect(status.branch).toEqual({
      oid: 'abcdef',
      head: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
    });
    expect(status.stashCount).toBe(3);
    expect(status.entries.map((e) => `${e.kind}:${e.index}${e.worktree}:${e.path}`)).toEqual([
      'changed:M.:staged.txt',
      'changed:.M:dir/with space.txt',
      'renamed:R.:new name.txt',
      'unmerged:UU:conflict.txt',
      'untracked:??:untracked.txt',
    ]);
    expect(status.entries[2]?.origPath).toBe('old name.txt');
    expect(summarizeStatus(status)).toEqual({ staged: 2, unstaged: 1, untracked: 1, conflicted: 1 });
  });
});

describe('parseRawNumstat', () => {
  it('joins raw status with line counts, including renames and binaries', () => {
    const output = [
      ':100644 100644 aaa bbb M',
      'src/a.ts',
      ':000000 100644 000 ccc A',
      'img.png',
      ':100644 100644 ddd eee R087',
      'old/b.ts',
      'new/b.ts',
      ':100644 000000 fff 000 D',
      'gone.txt',
      '5\t2\tsrc/a.ts',
      '-\t-\timg.png',
      '1\t1\t',
      'old/b.ts',
      'new/b.ts',
      '0\t9\tgone.txt',
      '',
    ].join('\0');
    expect(parseRawNumstat(output)).toEqual([
      { status: 'M', path: 'src/a.ts', additions: 5, deletions: 2, binary: false },
      { status: 'A', path: 'img.png', additions: 0, deletions: 0, binary: true },
      {
        status: 'R',
        score: 87,
        oldPath: 'old/b.ts',
        path: 'new/b.ts',
        additions: 1,
        deletions: 1,
        binary: false,
      },
      { status: 'D', path: 'gone.txt', additions: 0, deletions: 9, binary: false },
    ]);
  });
});
