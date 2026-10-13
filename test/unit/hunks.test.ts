import { describe, expect, it } from 'vitest';
import { buildLinePatch, selectedLines, wholeFileReason } from '../../src/core/repo/linePatch';
import { parseFilePatch } from '../../src/core/parsers/unifiedDiff';
import { isLineSelection } from '../../src/shared/hunks';

const NO_EOL = '\\ No newline at end of file';
const text = (...lines: string[]) => `${lines.join('\n')}\n`;
const MODIFIED = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
];
const HEADER = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt'];

/** a…l, with b → B and X added after c (hunk 0), k → K and m added at the end (hunk 1). */
const TWO_HUNKS = text(
  ...MODIFIED,
  '@@ -1,6 +1,7 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '+X',
  ' d',
  ' e',
  ' f',
  '@@ -8,5 +9,6 @@ function tail() {',
  ' h',
  ' i',
  ' j',
  '-k',
  '+K',
  ' l',
  '+m',
);

/** "x\nold" → "x\nnew", neither ending with a line break. */
const LAST_LINE = text(...MODIFIED, '@@ -1,2 +1,2 @@', ' x', '-old', NO_EOL, '+new', NO_EOL);

const NEW_FILE = text(
  'diff --git a/n.txt b/n.txt',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/n.txt',
  '@@ -0,0 +1,3 @@',
  '+l1',
  '+l2',
  '+l3',
);

const DELETED_FILE = text(
  'diff --git a/d.txt b/d.txt',
  'deleted file mode 100644',
  'index abc1234..0000000',
  '--- a/d.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-l1',
  '-l2',
);

const build = (diff: string, selection: Parameters<typeof buildLinePatch>[1], reverse = false) =>
  buildLinePatch(parseFilePatch(diff), selection, reverse)?.text;

describe('parseFilePatch', () => {
  it('reads hunks, line numbers and the function context', () => {
    const patch = parseFilePatch(TWO_HUNKS);
    expect(patch.files).toBe(1);
    expect(patch.header).toEqual(MODIFIED);
    expect(patch.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.section])).toEqual([
      [1, 6, 1, 7, ''],
      [8, 5, 9, 6, 'function tail() {'],
    ]);
    expect(patch.hunks[0]!.lines).toEqual([
      { kind: ' ', text: 'a', noEol: false, oldLine: 1, newLine: 1 },
      { kind: '-', text: 'b', noEol: false, oldLine: 2 },
      { kind: '+', text: 'B', noEol: false, newLine: 2 },
      { kind: ' ', text: 'c', noEol: false, oldLine: 3, newLine: 3 },
      { kind: '+', text: 'X', noEol: false, newLine: 4 },
      { kind: ' ', text: 'd', noEol: false, oldLine: 4, newLine: 5 },
      { kind: ' ', text: 'e', noEol: false, oldLine: 5, newLine: 6 },
      { kind: ' ', text: 'f', noEol: false, oldLine: 6, newLine: 7 },
    ]);
    expect(patch.hunks[1]!.lines.at(-1)).toEqual({ kind: '+', text: 'm', noEol: false, newLine: 14 });
    expect([patch.created, patch.deleted, patch.binary, patch.renamed, patch.combined]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(patch.modes).toEqual(['100644']);
  });

  it('marks lines that end their file without a line break, on either side or both', () => {
    const changed = parseFilePatch(LAST_LINE).hunks[0]!.lines;
    expect(changed.map((line) => [line.kind, line.noEol])).toEqual([
      [' ', false],
      ['-', true],
      ['+', true],
    ]);
    const context = parseFilePatch(text(...MODIFIED, '@@ -1,2 +1,2 @@', '-a', '+A', ' z', NO_EOL));
    expect(context.hunks[0]!.lines.at(-1)).toEqual({
      kind: ' ',
      text: 'z',
      noEol: true,
      oldLine: 2,
      newLine: 2,
    });
  });

  it('reads single-line ranges, empty context lines and CR at line ends verbatim', () => {
    const patch = parseFilePatch(
      text(...MODIFIED, '@@ -2 +2 @@', '-old\r', '+new\r', '@@ -9,3 +9,3 @@', '', '-y', '+Y', ' '),
    );
    expect(patch.hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 });
    expect(patch.hunks[0]!.lines.map((line) => line.text)).toEqual(['old\r', 'new\r']);
    expect(patch.hunks[1]!.lines.map((line) => [line.kind, line.text])).toEqual([
      [' ', ''],
      ['-', 'y'],
      ['+', 'Y'],
      [' ', ''],
    ]);
  });

  it('tells new, deleted, binary, renamed, mode-changed and conflicted files apart', () => {
    expect(parseFilePatch(NEW_FILE)).toMatchObject({ created: true, deleted: false, modes: ['100644'] });
    expect(parseFilePatch(DELETED_FILE)).toMatchObject({ created: false, deleted: true });
    const binary = parseFilePatch(
      text('diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ'),
    );
    expect(binary).toMatchObject({ binary: true, hunks: [] });
    expect(wholeFileReason(binary)).toBe('binary');
    const renamed = parseFilePatch(
      text('diff --git a/a.ts b/b.ts', 'similarity index 90%', 'rename from a.ts', 'rename to b.ts'),
    );
    expect(wholeFileReason(renamed)).toBe('renamed');
    const mode = parseFilePatch(text('diff --git a/s.sh b/s.sh', 'old mode 100644', 'new mode 100755'));
    expect(mode).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(wholeFileReason(mode)).toBe('modeChange');
    const submodule = parseFilePatch(
      text(
        'diff --git a/lib b/lib',
        'index 1..2 160000',
        '--- a/lib',
        '+++ b/lib',
        '@@ -1 +1 @@',
        '-Subproject commit 1',
        '+Subproject commit 2',
      ),
    );
    expect(wholeFileReason(submodule)).toBe('submodule');
    const link = parseFilePatch(
      text(
        'diff --git a/l b/l',
        'new file mode 120000',
        '--- /dev/null',
        '+++ b/l',
        '@@ -0,0 +1 @@',
        '+target',
        NO_EOL,
      ),
    );
    expect(wholeFileReason(link)).toBe('symlink');
    const conflict = parseFilePatch(
      text('diff --cc c.txt', 'index 1,2..3', '@@@ -1,1 -1,1 +1,5 @@@', '++<<<<<<< ours'),
    );
    expect(conflict).toMatchObject({ combined: true, hunks: [] });
    expect(parseFilePatch(TWO_HUNKS + NEW_FILE).files).toBe(2);
    expect(parseFilePatch('')).toMatchObject({ files: 0, hunks: [] });
  });

  it('refuses hunks that do not match their line counts', () => {
    expect(() => parseFilePatch(text(...MODIFIED, '@@ -1,2 +1,2 @@', ' a', '-b'))).toThrow(/ends early/);
    expect(() => parseFilePatch(text(...MODIFIED, '@@ -1 +1 @@', '+a', '+b'))).toThrow(/line counts/);
    expect(() => parseFilePatch(text(...MODIFIED, '@@ -1 +1 @@', NO_EOL))).toThrow(/marker/);
  });
});

describe('buildLinePatch: staging (forward)', () => {
  it('stages a later hunk alone at its place in the index', () => {
    expect(build(TWO_HUNKS, { hunks: [1] })).toBe(
      text(...HEADER, '@@ -8,5 +8,6 @@ function tail() {', ' h', ' i', ' j', '-k', '+K', ' l', '+m'),
    );
  });

  it('keeps unselected removals as context, drops unselected additions, and moves later hunks', () => {
    const patch = buildLinePatch(
      parseFilePatch(TWO_HUNKS),
      {
        lines: [
          { hunk: 0, line: 4 },
          { hunk: 1, line: 6 },
        ],
      },
      false,
    )!;
    expect(patch.text).toBe(
      text(
        ...HEADER,
        '@@ -1,6 +1,7 @@',
        ' a',
        ' b',
        ' c',
        '+X',
        ' d',
        ' e',
        ' f',
        '@@ -8,5 +9,6 @@ function tail() {',
        ' h',
        ' i',
        ' j',
        ' k',
        ' l',
        '+m',
      ),
    );
    expect([patch.added, patch.removed]).toEqual([2, 0]);
  });

  it('accounts for the lines an earlier hunk removes', () => {
    expect(
      build(TWO_HUNKS, {
        lines: [
          { hunk: 0, line: 1 },
          { hunk: 1, line: 4 },
        ],
      }),
    ).toBe(
      text(
        ...HEADER,
        '@@ -1,6 +1,5 @@',
        ' a',
        '-b',
        ' c',
        ' d',
        ' e',
        ' f',
        '@@ -8,5 +7,6 @@ function tail() {',
        ' h',
        ' i',
        ' j',
        ' k',
        '+K',
        ' l',
      ),
    );
  });

  it('gives the old last line a line break when a line is added after it', () => {
    expect(build(LAST_LINE, { lines: [{ hunk: 0, line: 2 }] })).toBe(
      text(...HEADER, '@@ -1,2 +1,3 @@', ' x', '-old', NO_EOL, '+old', '+new', NO_EOL),
    );
  });

  it('removes a last line without a line break, leaving the line before it last', () => {
    expect(build(LAST_LINE, { lines: [{ hunk: 0, line: 1 }] })).toBe(
      text(...HEADER, '@@ -1,2 +1 @@', ' x', '-old', NO_EOL),
    );
  });

  it('stages adding or removing the final line break', () => {
    const removeBreak = text(...MODIFIED, '@@ -1,2 +1,2 @@', ' a', '-b', '+b', NO_EOL);
    expect(build(removeBreak, { hunks: [0] })).toBe(
      text(...HEADER, '@@ -1,2 +1,2 @@', ' a', '-b', '+b', NO_EOL),
    );
    const addBreak = text(...MODIFIED, '@@ -1,2 +1,2 @@', ' a', '-b', NO_EOL, '+b');
    expect(build(addBreak, { hunks: [0] })).toBe(
      text(...HEADER, '@@ -1,2 +1,2 @@', ' a', '-b', NO_EOL, '+b'),
    );
    // Just the new line: the old one stays, and gets a line break to have one after it.
    expect(build(addBreak, { lines: [{ hunk: 0, line: 2 }] })).toBe(
      text(...HEADER, '@@ -1,2 +1,3 @@', ' a', '-b', NO_EOL, '+b', '+b'),
    );
  });

  it('stages lines added at the very start of a file', () => {
    const top = text(...MODIFIED, '@@ -1,3 +1,5 @@', '+one', '+two', ' a', ' b', ' c');
    expect(build(top, { lines: [{ hunk: 0, line: 1 }] })).toBe(
      text(...HEADER, '@@ -1,3 +1,4 @@', '+two', ' a', ' b', ' c'),
    );
  });

  it('stages part of a new file as a new file with just those lines', () => {
    expect(
      build(NEW_FILE, {
        lines: [
          { hunk: 0, line: 0 },
          { hunk: 0, line: 2 },
        ],
      }),
    ).toBe(
      text(
        'diff --git a/n.txt b/n.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/n.txt',
        '@@ -0,0 +1,2 @@',
        '+l1',
        '+l3',
      ),
    );
  });

  it('stages part of a deletion as an edit, all of it as the deletion', () => {
    expect(build(DELETED_FILE, { lines: [{ hunk: 0, line: 0 }] })).toBe(
      text('diff --git a/d.txt b/d.txt', '--- a/d.txt', '+++ b/d.txt', '@@ -1,2 +1 @@', '-l1', ' l2'),
    );
    expect(build(DELETED_FILE, { hunks: [0] })).toBe(
      text(
        'diff --git a/d.txt b/d.txt',
        'deleted file mode 100644',
        '--- a/d.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-l1',
        '-l2',
      ),
    );
  });
});

describe('buildLinePatch: unstaging and discarding (reverse)', () => {
  it('keeps unselected additions as context and drops unselected removals', () => {
    expect(build(TWO_HUNKS, { lines: [{ hunk: 0, line: 1 }] }, true)).toBe(
      text(...HEADER, '@@ -1,8 +1,7 @@', ' a', '-b', ' B', ' c', ' X', ' d', ' e', ' f'),
    );
    expect(build(TWO_HUNKS, { lines: [{ hunk: 1, line: 6 }] }, true)).toBe(
      text(...HEADER, '@@ -9,5 +9,6 @@ function tail() {', ' h', ' i', ' j', ' K', ' l', '+m'),
    );
  });

  it('moves the computed side of later hunks by what earlier ones take back', () => {
    expect(
      build(
        TWO_HUNKS,
        {
          lines: [
            { hunk: 0, line: 4 },
            { hunk: 1, line: 3 },
          ],
        },
        true,
      ),
    ).toBe(
      text(
        ...HEADER,
        '@@ -1,6 +1,7 @@',
        ' a',
        ' B',
        ' c',
        '+X',
        ' d',
        ' e',
        ' f',
        '@@ -8,7 +9,6 @@ function tail() {',
        ' h',
        ' i',
        ' j',
        '-k',
        ' K',
        ' l',
        ' m',
      ),
    );
  });

  it('handles lines that end the file without a line break', () => {
    // Taking back the new last line alone: the line before it ends the file again.
    expect(build(LAST_LINE, { lines: [{ hunk: 0, line: 2 }] }, true)).toBe(
      text(...HEADER, '@@ -1 +1,2 @@', ' x', '+new', NO_EOL),
    );
    // Bringing back the old last line alone: it is no longer last, so it gets a line break.
    expect(build(LAST_LINE, { lines: [{ hunk: 0, line: 1 }] }, true)).toBe(
      text(...HEADER, '@@ -1,3 +1,2 @@', ' x', '-old', ' new', NO_EOL),
    );
  });

  it('takes back part of a new file in place, all of it as the file', () => {
    expect(build(NEW_FILE, { lines: [{ hunk: 0, line: 1 }] }, true)).toBe(
      text(
        'diff --git a/n.txt b/n.txt',
        '--- a/n.txt',
        '+++ b/n.txt',
        '@@ -1,2 +1,3 @@',
        ' l1',
        '+l2',
        ' l3',
      ),
    );
    expect(build(NEW_FILE, { hunks: [0] }, true)).toBe(
      text(
        'diff --git a/n.txt b/n.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/n.txt',
        '@@ -0,0 +1,3 @@',
        '+l1',
        '+l2',
        '+l3',
      ),
    );
  });

  it('brings back part of a deleted file as the file with those lines', () => {
    expect(build(DELETED_FILE, { lines: [{ hunk: 0, line: 1 }] }, true)).toBe(
      text(
        'diff --git a/d.txt b/d.txt',
        'deleted file mode 100644',
        '--- a/d.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-l2',
      ),
    );
  });
});

describe('buildLinePatch: headers and refusals', () => {
  it('names files with spaces and quoted names the way git spelled them', () => {
    const spaced = text(
      'diff --git a/my file.txt b/my file.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/my file.txt\t',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    );
    expect(
      build(spaced, { lines: [{ hunk: 0, line: 0 }] }, true)!
        .split('\n')
        .slice(0, 3),
    ).toEqual(['diff --git a/my file.txt b/my file.txt', '--- a/my file.txt\t', '+++ b/my file.txt\t']);
    const quoted = text(
      'diff --git "a/tab\\there" "b/tab\\there"',
      'deleted file mode 100644',
      '--- "a/tab\\there"',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    );
    expect(
      build(quoted, { lines: [{ hunk: 0, line: 0 }] })!
        .split('\n')
        .slice(1, 3),
    ).toEqual(['--- "a/tab\\there"', '+++ "b/tab\\there"']);
  });

  it('returns nothing for an empty selection, and refuses positions that are not changes', () => {
    expect(build(TWO_HUNKS, {})).toBeUndefined();
    expect(build(TWO_HUNKS, { hunks: [], lines: [] }, true)).toBeUndefined();
    expect(() => build(TWO_HUNKS, { hunks: [2] })).toThrow(/no hunk 3/);
    expect(() => build(TWO_HUNKS, { lines: [{ hunk: 0, line: 8 }] })).toThrow(/no line 9 in hunk 1/);
    expect(() => build(TWO_HUNKS, { lines: [{ hunk: 0, line: 0 }] })).toThrow(/added or removed/);
  });

  it('counts a hunk and its lines once', () => {
    const keys = selectedLines(parseFilePatch(TWO_HUNKS), { hunks: [0, 0], lines: [{ hunk: 0, line: 1 }] });
    expect([...keys]).toEqual(['0:1', '0:2', '0:4']);
  });

  it('refuses diffs that only allow whole-file actions', () => {
    const binary = text(
      'diff --git a/i.png b/i.png',
      'index 1..2 100644',
      'Binary files a/i.png and b/i.png differ',
    );
    expect(() => build(binary, { hunks: [0] })).toThrow(/binary/);
    const mode = text(
      ...HEADER.slice(0, 1),
      'old mode 100644',
      'new mode 100755',
      ...HEADER.slice(1),
      '@@ -1 +1 @@',
      '-a',
      '+b',
    );
    expect(() => build(mode, { hunks: [0] })).toThrow(/mode/);
    expect(() => build(TWO_HUNKS + NEW_FILE, { hunks: [0] })).toThrow(/one changed file/);
  });
});

describe('isLineSelection', () => {
  it('accepts hunk and line positions only', () => {
    expect(isLineSelection({})).toBe(true);
    expect(isLineSelection({ hunks: [0, 3], lines: [{ hunk: 1, line: 2 }] })).toBe(true);
    expect(isLineSelection(null)).toBe(false);
    expect(isLineSelection({ hunks: [-1] })).toBe(false);
    expect(isLineSelection({ hunks: [1.5] })).toBe(false);
    expect(isLineSelection({ hunks: '0' })).toBe(false);
    expect(isLineSelection({ lines: [{ hunk: 0 }] })).toBe(false);
    expect(isLineSelection({ lines: [[0, 1]] })).toBe(false);
    expect(isLineSelection({ lines: [{ hunk: 0, line: 1e9 }] })).toBe(false);
  });
});
