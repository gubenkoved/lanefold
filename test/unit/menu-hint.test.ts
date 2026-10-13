import { describe, expect, it } from 'vitest';
import { hintKind } from '../../src/webview/components/menuHint';

describe('menu hints', () => {
  it('show git commands after a prompt', () => {
    expect(hintKind('git cherry-pick 1c1a40e3')).toBe('command');
    expect(hintKind('git rebase -i (edit)')).toBe('command');
    expect(hintKind('git diff 4b533950...1c1a40e3')).toBe('command');
  });

  it('show notes in words as prose (no prompt)', () => {
    for (const note of [
      'new message, same changes',
      'leave it out of the history',
      'one commit, both messages',
      'keeps 4b533950’s message',
      'Switch to it here',
      'the first commit has nothing before it',
    ])
      expect(hintKind(note)).toBe('note');
  });

  it('show values as code', () => {
    for (const value of [
      'HEAD',
      '--topo-order',
      '--branches --remotes --tags HEAD',
      '4b533950',
      'abcdef12',
      '1c1a40e3 → 096486b7',
      'https://example.com/aurora.git',
      '/home/me/aurora',
    ])
      expect(hintKind(value)).toBe('code');
  });
});
