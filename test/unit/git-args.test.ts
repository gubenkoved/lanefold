import { describe, expect, it } from 'vitest';
import {
  assertRevision,
  formatCommand,
  filePaths,
  pathspecs,
  quoteShellArg,
  revisions,
  validateRefName,
} from '../../src/core/git/args';

describe('validateRefName', () => {
  it.each(['main', 'feature/login', 'release-1.2', 'user/jane/fix_42', 'v1.0.0', 'UPPER'])(
    'accepts %s',
    (name) => {
      expect(validateRefName(name)).toBeUndefined();
    },
  );

  it.each([
    ['', /empty/],
    ['-oops', /start with “-”/],
    ['has space', /forbidden/],
    ['a..b', /\.\./],
    ['a~1', /forbidden/],
    ['a^', /forbidden/],
    ['a:b', /forbidden/],
    ['what?', /forbidden/],
    ['star*', /forbidden/],
    ['br[ack', /forbidden/],
    ['back\\slash', /forbidden/],
    ['x@{1}', /@\{/],
    ['@', /“@”/],
    ['a//b', /\/\//],
    ['/lead', /start or end/],
    ['trail/', /start or end/],
    ['dot.', /end with “\.”/],
    ['feature/.hidden', /start with “\.”/],
    ['refs/heads/x.lock', /\.lock/],
  ])('rejects %j', (name, message) => {
    expect(validateRefName(name)).toMatch(message);
  });
});

describe('revisions / pathspecs', () => {
  it('guards revisions with --end-of-options', () => {
    expect(revisions('main', 'HEAD~2')).toEqual(['--end-of-options', 'main', 'HEAD~2']);
  });

  it('refuses option-like revisions', () => {
    expect(() => assertRevision('--upload-pack=evil')).toThrow(/option/);
    expect(() => assertRevision('')).toThrow();
    expect(() => assertRevision('a\nb')).toThrow(/control/);
  });

  it('separates pathspecs with --', () => {
    expect(pathspecs('a.txt', '-weird')).toEqual(['--', 'a.txt', '-weird']);
    expect(pathspecs()).toEqual([]);
  });

  it('marks file names that git would read as patterns as literal', () => {
    expect(filePaths('src/a.ts', '-weird', 'my file.md')).toEqual(['--', 'src/a.ts', '-weird', 'my file.md']);
    expect(filePaths('*.css', 'notes/[draft].md', 'a?b', ':top', 'back\\slash')).toEqual([
      '--',
      ':(literal)*.css',
      ':(literal)notes/[draft].md',
      ':(literal)a?b',
      ':(literal):top',
      ':(literal)back\\slash',
    ]);
    expect(filePaths()).toEqual([]);
  });
});

describe('formatCommand', () => {
  it('leaves simple words bare', () => {
    expect(formatCommand(['rebase', '-i', '--autostash', 'abc1234'])).toBe(
      'git rebase -i --autostash abc1234',
    );
  });

  it('quotes words with spaces and quotes', () => {
    expect(quoteShellArg("it's done")).toBe(`'it'\\''s done'`);
    expect(formatCommand(['commit', '-m', 'Fix the bug'])).toBe("git commit -m 'Fix the bug'");
    expect(quoteShellArg('')).toBe("''");
  });

  it('keeps refs and ranges readable', () => {
    expect(formatCommand(['log', 'main..feature/x', 'HEAD~3', '@{u}'])).toBe(
      'git log main..feature/x HEAD~3 @{u}',
    );
  });
});
