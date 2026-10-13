import { describe, expect, it } from 'vitest';
import { redactCredentials, tokenizeCommand } from '../../src/shared/shell';

describe('tokenizeCommand', () => {
  it('tags each part of a command line', () => {
    const tokens = tokenizeCommand([
      '-c',
      'color.ui=false',
      'rebase',
      '-i',
      '--onto',
      'main',
      'HEAD~3',
      '--',
      'src/a b.ts',
    ]);
    expect(tokens).toEqual([
      { text: 'git', kind: 'program' },
      { text: '-c', kind: 'config' },
      { text: 'color.ui=false', kind: 'config' },
      { text: 'rebase', kind: 'subcommand' },
      { text: '-i', kind: 'option' },
      { text: '--onto', kind: 'option' },
      { text: 'main', kind: 'revision' },
      { text: 'HEAD~3', kind: 'revision' },
      { text: '--', kind: 'separator' },
      { text: "'src/a b.ts'", kind: 'path' },
    ]);
  });

  it('treats the argument after -m as a value', () => {
    const kinds = tokenizeCommand(['commit', '-m', 'Fix it', '--amend']).map((t) => t.kind);
    expect(kinds).toEqual(['program', 'subcommand', 'option', 'value', 'option']);
  });

  it('keeps arguments after --end-of-options as revisions', () => {
    const tokens = tokenizeCommand(['log', '--end-of-options', 'main']);
    expect(tokens.map((t) => t.kind)).toEqual(['program', 'subcommand', 'separator', 'revision']);
  });
});

describe('redactCredentials', () => {
  it('hides tokens and passwords in URLs, not ssh user names', () => {
    expect(redactCredentials('https://ann:ghp_s3cret@github.com/a/b.git')).toBe(
      'https://***@github.com/a/b.git',
    );
    expect(redactCredentials("fatal: unable to access 'https://ghp_s3cret@github.com/a/b.git/'")).toBe(
      "fatal: unable to access 'https://***@github.com/a/b.git/'",
    );
    expect(redactCredentials('ssh://git@github.com/a/b.git')).toBe('ssh://git@github.com/a/b.git');
    expect(redactCredentials('ftp://user:pw@host/x')).toBe('ftp://***@host/x');
    expect(redactCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(redactCredentials('see https://github.com/a/b and me@example.com')).toBe(
      'see https://github.com/a/b and me@example.com',
    );
  });
});
