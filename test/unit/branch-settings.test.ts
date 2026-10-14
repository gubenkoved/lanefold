import { describe, expect, it } from 'vitest';
import { parseBranchSettings } from '../../src/core/repo/branchSettings';

describe('parseBranchSettings', () => {
  // `git config -z --get-regexp ^branch\.`: key, newline, value, NUL (no newline without a value).
  const output = [
    'branch.main.remote\norigin',
    'branch.main.merge\nrefs/heads/main',
    // Another branch whose name starts the same way.
    'branch.rel.1.0.remote\nupstream',
    'branch.rel.remote\norigin',
    'branch.rel.merge\nrefs/heads/rel',
    'branch.rel.pushremote\nfork',
    // Without a value: on.
    'branch.rel.rebase',
    // Not brought back.
    'branch.rel.mergeoptions\n--no-ff',
    'branch.rel.description\nFirst line\nsecond line',
    '',
  ].join('\0');

  it('reads where a branch pulls from and pushes to, and its description', () => {
    expect(parseBranchSettings(output, 'rel')).toEqual([
      ['remote', 'origin'],
      ['merge', 'refs/heads/rel'],
      ['pushremote', 'fork'],
      ['rebase', 'true'],
      ['description', 'First line\nsecond line'],
    ]);
  });

  it('keeps branches whose names hold dots apart', () => {
    expect(parseBranchSettings(output, 'rel.1.0')).toEqual([['remote', 'upstream']]);
    expect(parseBranchSettings(output, 'rel.1')).toEqual([]);
    expect(parseBranchSettings(output, 'none')).toEqual([]);
    expect(parseBranchSettings('', 'main')).toEqual([]);
  });
});
