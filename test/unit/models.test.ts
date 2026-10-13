import { describe, expect, it } from 'vitest';
import { parseRefScope, parseSearch } from '../../src/shared/models';

describe('parseSearch', () => {
  it('treats plain words as free text', () => {
    expect(parseSearch('  fix login  ')).toMatchObject({
      text: 'fix login',
      author: undefined,
      hash: undefined,
    });
    expect(parseSearch('')).toMatchObject({ text: undefined });
  });

  it('understands operators and shorthands', () => {
    expect(parseSearch('fix @alice file:src/ after:2024-01-01 m:login #ABC123')).toEqual({
      text: 'fix',
      author: 'alice',
      message: 'login',
      hash: 'abc123',
      paths: ['src/'],
      after: '2024-01-01',
      before: undefined,
    });
    expect(parseSearch('author:bob before:"2 weeks ago"')).toMatchObject({
      author: 'bob',
      before: '2 weeks ago',
    });
    expect(parseSearch('path:a path:b')).toMatchObject({ paths: ['a', 'b'] });
    expect(parseSearch('file:docs/a:b.md after:2024-01-01T10:00')).toMatchObject({
      paths: ['docs/a:b.md'],
      after: '2024-01-01T10:00',
    });
    expect(parseSearch('sha:DEADBEEF')).toMatchObject({ hash: 'deadbeef' });
  });

  it('supports quoted values and keeps unknown prefixes as text', () => {
    expect(parseSearch('author:"Jane Doe" "exact phrase"')).toMatchObject({
      author: 'Jane Doe',
      text: 'exact phrase',
    });
    expect(parseSearch('http://example.com')).toMatchObject({ text: 'http://example.com' });
    // A lone "#" or non-hex "#tag" is text, not a hash.
    expect(parseSearch('#release')).toMatchObject({ text: '#release', hash: undefined });
  });
});

describe('parseRefScope', () => {
  it('maps keywords and ref lists', () => {
    expect(parseRefScope('all')).toEqual({ type: 'all' });
    expect(parseRefScope('HEAD')).toEqual({ type: 'head' });
    expect(parseRefScope(' local ')).toEqual({ type: 'local' });
    expect(parseRefScope('main  feature/*')).toEqual({ type: 'refs', refs: ['main', 'feature/*'] });
  });
});
