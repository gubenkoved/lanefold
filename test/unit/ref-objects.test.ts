import { describe, expect, it } from 'vitest';
import {
  composeRefRecords,
  parseRefObject,
  parseRefRecords,
  splitRefRecords,
} from '../../src/core/parsers/refs';

const encode = (text: string) => new TextEncoder().encode(text);
const COMMIT = 'a'.repeat(40);
const TAG = 'b'.repeat(40);

describe('ref objects', () => {
  it('reads a commit’s committer date and a tag’s target and tagger date', () => {
    const commit = [
      `tree ${'c'.repeat(40)}`,
      `parent ${'d'.repeat(40)}`,
      'author A <a@x> 1700000000 +0100',
      'committer C <c@x> 1700000500 -0700',
      '',
      'subject',
      '',
      'committer X <x@x> 1 +0000',
    ].join('\n');
    expect(parseRefObject('commit', encode(commit))).toEqual({
      type: 'commit',
      peeled: undefined,
      date: 1700000500,
    });
    const tag = [
      `object ${COMMIT}`,
      'type commit',
      'tag v1',
      'tagger T <t@x> 1700000900 +0000',
      '',
      'Release',
    ];
    expect(parseRefObject('tag', encode(tag.join('\n')))).toEqual({
      type: 'tag',
      peeled: COMMIT,
      date: 1700000900,
    });
    // Very old tags have no tagger: no date, like %(creatordate).
    const old = [`object ${COMMIT}`, 'type commit', 'tag v0', '', 'Old'];
    expect(parseRefObject('tag', encode(old.join('\n')))).toEqual({
      type: 'tag',
      peeled: COMMIT,
      date: undefined,
    });
    expect(parseRefObject('tree', encode('100644 file'))).toEqual({ type: 'tree' });
  });

  it('composes full records that parse like a full for-each-ref read', () => {
    const fast = [
      ['refs/heads/main', COMMIT, 'origin/main', 'ahead 2', '*', ''],
      ['refs/remotes/origin/HEAD', COMMIT, '', '', ' ', 'refs/remotes/origin/main'],
      ['refs/tags/v1', TAG, '', '', ' ', ''],
      ['refs/tags/unknown', 'e'.repeat(40), '', '', ' ', ''],
    ]
      .map((fields) => fields.join('\u0000'))
      .join('\n');
    const objects = new Map([
      [COMMIT, { type: 'commit', date: 1700000500 }],
      [TAG, { type: 'tag', peeled: COMMIT, date: 1700000900 }],
    ]);
    expect(parseRefRecords(composeRefRecords(splitRefRecords(`${fast}\n`), objects))).toEqual([
      {
        name: 'refs/heads/main',
        short: 'main',
        kind: 'branch',
        target: COMMIT,
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        isHead: true,
        date: 1700000500,
      },
      { name: 'refs/tags/v1', short: 'v1', kind: 'tag', target: COMMIT, annotated: true, date: 1700000900 },
    ]);
  });
});
