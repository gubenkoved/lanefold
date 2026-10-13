import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/core/git/errors';
import { submoduleFailure, submoduleMessage } from '../../src/core/ops/plans/submodules';
import { parseRawNumstat } from '../../src/core/parsers/diff';
import { parseStatus, parseSubmoduleField } from '../../src/core/parsers/status';
import {
  isSafeSubmodulePath,
  parseConfigValues,
  parseGitlinkConflicts,
  parseGitlinks,
  parseSubmoduleConfig,
  resolveSubmoduleUrl,
} from '../../src/core/parsers/submodules';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

describe('resolveSubmoduleUrl', () => {
  // What `git submodule init` wrote for these URLs and remotes (git 2.43).
  it.each([
    ['../lib.git', '/tmp/work/super', '/tmp/work/lib.git'],
    ['./lib', '/tmp/work/super', '/tmp/work/super/lib'],
    ['../../x/lib', '/tmp/work/super', '/tmp/x/lib'],
    ['../lib/', '/tmp/work/super', '/tmp/work/lib'],
    ['../lib.git', 'https://example.com/org/super.git', 'https://example.com/org/lib.git'],
    ['./lib', 'https://example.com/org/super.git', 'https://example.com/org/super.git/lib'],
    ['../../x/lib', 'https://example.com/org/super/', 'https://example.com/x/lib'],
    ['../lib.git', 'git@example.com:org/super.git', 'git@example.com:org/lib.git'],
    ['../../x/lib', 'git@example.com:org/super.git', 'git@example.com:x/lib'],
    ['../lib.git', 'git@example.com:super.git', 'git@example.com:lib.git'],
    ['../../x/lib', 'git@example.com:super.git', '.:x/lib'],
    ['../lib.git', 'file:///srv/git/super.git', 'file:///srv/git/lib.git'],
    ['../lib.git', '../relative/super', '../relative/lib.git'],
    ['../../x/lib', '../relative/super', '../x/lib'],
    ['../lib.git', 'C:/repos/super', 'C:/repos/lib.git'],
  ])('%s against %s → %s', (url, base, resolved) => {
    expect(resolveSubmoduleUrl(url, base)).toBe(resolved);
  });

  it('keeps URLs that are not relative, and gives up where git would', () => {
    expect(resolveSubmoduleUrl('https://example.com/lib.git', '/tmp/super')).toBe(
      'https://example.com/lib.git',
    );
    expect(resolveSubmoduleUrl('/srv/lib', '/tmp/super')).toBe('/srv/lib');
    expect(resolveSubmoduleUrl('../../../lib', 'super')).toBeUndefined();
  });
});

describe('parseConfigValues', () => {
  it('reads -z records by key, values with any characters', () => {
    const values = parseConfigValues(
      [
        'submodule.libs/lib.url\n/srv/lib',
        'remote.origin.url\nhttps://example.com/a b',
        'branch.Main.remote\nup',
        '',
      ].join('\0'),
    );
    expect([...values]).toEqual([
      ['submodule.libs/lib.url', '/srv/lib'],
      ['remote.origin.url', 'https://example.com/a b'],
      ['branch.Main.remote', 'up'],
    ]);
  });
});

describe('parseGitlinkConflicts', () => {
  it('keeps conflicts whose stages are all gitlinks, with each side’s commit', () => {
    const stdout = [
      `160000 ${A} 1\tlibs/lib`,
      `160000 ${B} 2\tlibs/lib`,
      `160000 ${C} 3\tlibs/lib`,
      // Removed on the incoming side.
      `160000 ${A} 1\tlibs/gone`,
      `160000 ${B} 2\tlibs/gone`,
      // A file against a submodule: no choice of commits.
      `100644 ${A} 2\ttools`,
      `160000 ${B} 3\ttools`,
      `100644 ${A} 1\tREADME.md`,
      `100644 ${B} 2\tREADME.md`,
      `100644 ${C} 3\tREADME.md`,
      '',
    ].join('\0');
    expect(parseGitlinkConflicts(stdout)).toEqual([
      { path: 'libs/lib', ours: B, theirs: C },
      { path: 'libs/gone', ours: B, theirs: undefined },
    ]);
  });
});

describe('parseSubmoduleConfig', () => {
  it('reads .gitmodules records, with names that contain dots and keys in any case', () => {
    const stdout = [
      'submodule.libs/lib.path\nlibs/lib',
      'submodule.libs/lib.url\n../lib.git',
      'submodule.ui.kit.path\nvendor/ui kit',
      'submodule.ui.kit.URL\nhttps://example.com/kit.git',
      'submodule.ui.kit.branch\nstable',
      'submodule.ui.kit.update\nrebase',
      'submodule.bare',
      'core.bare\nfalse',
      '',
    ].join('\0');
    expect(parseSubmoduleConfig(stdout)).toEqual([
      { name: 'libs/lib', path: 'libs/lib', url: '../lib.git' },
      {
        name: 'ui.kit',
        path: 'vendor/ui kit',
        url: 'https://example.com/kit.git',
        branch: 'stable',
        update: 'rebase',
      },
    ]);
  });

  it('keeps no entries for empty output', () => {
    expect(parseSubmoduleConfig('')).toEqual([]);
  });
});

describe('isSafeSubmodulePath', () => {
  it('accepts relative, normalized paths inside the repository', () => {
    for (const path of ['lib', 'libs/lib', 'vendor/ui kit', 'a.b/c-d'])
      expect(isSafeSubmodulePath(path), path).toBe(true);
  });

  it('refuses paths a hostile .gitmodules could hold', () => {
    for (const path of [
      undefined,
      '',
      '-c',
      '/etc',
      'C:/Windows',
      '../outside',
      'libs/../../x',
      'libs//lib',
      './lib',
      'lib/',
      '.git',
      'libs/.GIT/hooks',
      'li\\b',
      'lib\nx',
    ])
      expect(isSafeSubmodulePath(path), String(path)).toBe(false);
  });
});

describe('parseGitlinks', () => {
  it('keeps the gitlinks of `ls-files --stage -z`, and the sides of a conflict', () => {
    const stdout = [
      `100644 ${A} 0\tREADME.md`,
      `160000 ${B} 0\tlibs/lib`,
      `160000 ${A} 1\tlibs/ui kit`,
      `160000 ${B} 2\tlibs/ui kit`,
      `160000 ${C} 3\tlibs/ui kit`,
      '',
    ].join('\0');
    const links = parseGitlinks(stdout);
    expect([...links.keys()]).toEqual(['libs/lib', 'libs/ui kit']);
    expect(links.get('libs/lib')).toEqual({ path: 'libs/lib', oid: B, conflicted: false });
    expect(links.get('libs/ui kit')).toEqual({ path: 'libs/ui kit', conflicted: true, ours: B });
  });
});

describe('the submodule field of porcelain v2 status', () => {
  it('parses S<c><m><u> and leaves other entries alone', () => {
    expect(parseSubmoduleField('N...')).toBeUndefined();
    expect(parseSubmoduleField('S...')).toEqual({ commitChanged: false, modified: false, untracked: false });
    expect(parseSubmoduleField('SCMU')).toEqual({ commitChanged: true, modified: true, untracked: true });
    expect(parseSubmoduleField('S.M.')).toEqual({ commitChanged: false, modified: true, untracked: false });
  });

  it('reads submodule entries with the commits HEAD and the index record', () => {
    const stdout = [
      `1 .M SC.. 160000 160000 160000 ${A} ${A} libs/lib`,
      `1 A. S... 000000 160000 160000 ${ZERO} ${B} vendor/new`,
      `1 .M N... 100644 100644 100644 ${A} ${A} README.md`,
      `u UU S... 160000 160000 160000 160000 ${A} ${B} ${C} libs/ui`,
      '',
    ].join('\0');
    const [moved, added, file, conflicted] = parseStatus(stdout).entries;
    expect(moved).toEqual(
      expect.objectContaining({
        path: 'libs/lib',
        submodule: { commitChanged: true, modified: false, untracked: false },
        headOid: A,
        indexOid: A,
      }),
    );
    expect(added).toEqual(expect.objectContaining({ path: 'vendor/new', headOid: undefined, indexOid: B }));
    expect(file?.submodule).toBeUndefined();
    // A conflict: the current side (stage 2) and the incoming one (stage 3).
    expect(conflicted).toEqual(
      expect.objectContaining({
        kind: 'unmerged',
        path: 'libs/ui',
        submodule: expect.any(Object),
        headOid: B,
        theirsOid: C,
      }),
    );
  });
});

describe('gitlinks in raw diffs', () => {
  it('records the commits on each side; files stay as they were', () => {
    const stdout = [
      `:160000 160000 ${A} ${B} M`,
      'libs/lib',
      `:000000 160000 ${ZERO} ${C} A`,
      'vendor/new',
      `:160000 000000 ${A} ${ZERO} D`,
      'libs/old',
      `:100644 160000 ${A} ${B} T`,
      'tools',
      // The working tree: git does not look up the commit checked out in the submodule.
      `:160000 160000 ${A} ${ZERO} M`,
      'libs/moved',
      `:100644 100644 ${A} ${B} M`,
      'README.md',
      '1\t1\tlibs/lib',
      '1\t0\tvendor/new',
      '0\t1\tlibs/old',
      '1\t1\ttools',
      '1\t1\tlibs/moved',
      '2\t1\tREADME.md',
      '',
    ].join('\0');
    const files = parseRawNumstat(stdout);
    expect(files.map((file) => [file.path, file.status, file.submodule])).toEqual([
      ['libs/lib', 'M', { from: A, to: B }],
      ['vendor/new', 'A', { from: undefined, to: C }],
      ['libs/old', 'D', { from: A, to: undefined }],
      ['tools', 'T', { from: undefined, to: B }],
      ['libs/moved', 'M', { from: A, to: undefined }],
      ['README.md', 'M', undefined],
    ]);
    expect('submodule' in files[5]!).toBe(false);
    // Lines counted for a submodule are git's "Subproject commit" lines: none are shown.
    expect(files.map((file) => file.additions + file.deletions)).toEqual([0, 0, 0, 0, 0, 3]);
  });
});

describe('submodule operation results', () => {
  const failure = (stderr: string) => new GitError(['submodule', 'update'], 1, stderr, '');
  const update = { kind: 'updateSubmodules', paths: ['libs/lib'] } as const;

  it('explains git’s refusal of local folders', () => {
    const error = failure(
      "Cloning into '/work/app/libs/lib'...\nfatal: transport 'file' not allowed\nfatal: clone of '/work/lib' into submodule path '/work/app/libs/lib' failed\n",
    );
    expect(submoduleFailure(update, error)).toMatch(
      /^Git refuses to clone or fetch a submodule from a local folder/,
    );
  });

  it('names the submodule whose changes are in the way', () => {
    const error = failure(
      "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\nfatal: Unable to checkout 'abc' in submodule path 'libs/lib'\n",
    );
    expect(submoduleFailure(update, error)).toBe(
      'Uncommitted changes in libs/lib (a.txt) are in the way: commit or stash them there first. Nothing was changed in it.',
    );
  });

  it('says when the recorded commit is not on the submodule’s remote', () => {
    const error = failure(
      `fatal: Fetched in submodule path 'libs/lib', but it did not contain ${A}. Direct fetching of that commit failed.\n`,
    );
    expect(submoduleFailure(update, error)).toBe(
      `libs/lib’s remote does not have ${A.slice(0, 8)}, the commit recorded here: it may not be pushed yet.`,
    );
  });

  it('says where a failed clone came from, with git’s reason', () => {
    const error = failure(
      [
        "Submodule 'libs/lib' (/srv/missing) registered for path 'vendor/lib'",
        "fatal: repository '/srv/missing' does not exist",
        "fatal: clone of '/srv/missing' into submodule path '/work/app/vendor/lib' failed",
        "Failed to clone 'vendor/lib'. Retry scheduled",
        '',
      ].join('\n'),
    );
    expect(submoduleFailure({ kind: 'updateSubmodules', paths: ['vendor/lib'], init: true }, error)).toBe(
      "Could not clone vendor/lib from /srv/missing: repository '/srv/missing' does not exist. Check its URL in .gitmodules (then sync it).",
    );
  });

  it('leaves other operations and other failures to git’s own words', () => {
    expect(
      submoduleFailure({ kind: 'fetch' }, failure("fatal: transport 'file' not allowed")),
    ).toBeUndefined();
    expect(submoduleFailure(update, failure('fatal: unable to access the remote'))).toBeUndefined();
  });

  it('describes what each operation did', () => {
    expect(submoduleMessage(update)).toBe('libs/lib is at the commit this repository records.');
    expect(submoduleMessage({ kind: 'updateSubmodules' })).toBe(
      'The submodules are at the commits this repository records.',
    );
    expect(submoduleMessage({ kind: 'fetch' })).toBeUndefined();
  });
});
