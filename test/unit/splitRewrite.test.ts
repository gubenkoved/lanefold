import { describe, expect, it } from 'vitest';
import {
  firstChange,
  groupRewrite,
  layoutTodo,
  normalizeRewrite,
  pickAll,
  renderTodo,
  splitCommits,
  validateRewrite,
  type RewriteEntry,
} from '../../src/shared/rewrite';

const shas = ['a', 'b', 'c', 'd'];
const messages: Record<string, string> = { a: 'A', b: 'B', c: 'C', d: 'D' };
const messageOf = (sha: string) => messages[sha];
const withAction = (sha: string, action: RewriteEntry['action']): RewriteEntry[] =>
  pickAll(shas.map((s) => ({ sha: s }))).map((entry) => (entry.sha === sha ? { sha, action } : entry));

describe('splitting in the rewrite model', () => {
  it('lays a split out as an edit stop in the todo', () => {
    const entries: RewriteEntry[] = [
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'split' },
      { sha: 'c', action: 'reword', message: 'C2' },
      { sha: 'd', action: 'split' },
    ];
    const layout = layoutTodo(entries, (group) => `carrier-${group.head.sha}`, shas);
    expect(layout.lines).toEqual(['pick a', 'edit b', 'pick c', 'fixup -C carrier-c', 'edit d']);
    expect(renderTodo(layout, (sha) => (sha === 'b' ? ['refs/heads/topic'] : []))).toBe(
      'pick a\nedit b\nupdate-ref refs/heads/topic\npick c\nfixup -C carrier-c\nedit d\n',
    );
    expect(splitCommits(entries)).toEqual(['b', 'd']);
  });

  it('counts a split as a change and as a commit of its own', () => {
    const entries = withAction('c', 'split');
    expect(firstChange(normalizeRewrite(entries, messageOf), shas)).toBe(2);
    expect(groupRewrite(entries).map((group) => group.head.sha)).toEqual(['a', 'b', 'c', 'd']);
    expect(groupRewrite(entries)[2]).toMatchObject({ head: { action: 'split' }, newMessage: false });
  });

  it('drops a message given to a split (its parts get theirs when committed)', () => {
    expect(normalizeRewrite([{ sha: 'b', action: 'split', message: 'ignored' }], messageOf)).toEqual([
      { sha: 'b', action: 'split' },
    ]);
  });

  it('validates splits', () => {
    expect(validateRewrite(withAction('b', 'split'))).toBeUndefined();
    // The first commit of the history has no parent to go back to…
    expect(validateRewrite(withAction('a', 'split'), { fromRoot: true })).toMatch(
      /first commit of the history cannot be split/,
    );
    // …unless the edit starts after a base, or another commit comes first.
    expect(validateRewrite(withAction('a', 'split'))).toBeUndefined();
    expect(
      validateRewrite(
        [
          { sha: 'a', action: 'drop' },
          { sha: 'b', action: 'split' },
        ],
        { fromRoot: true },
      ),
    ).toMatch(/cannot be split/);
    expect(
      validateRewrite(
        [
          { sha: 'b', action: 'pick' },
          { sha: 'a', action: 'split' },
        ],
        { fromRoot: true },
      ),
    ).toBeUndefined();
    // Nothing can be folded into a commit being split.
    for (const action of ['squash', 'fixup'] as const) {
      expect(
        validateRewrite([
          { sha: 'a', action: 'pick' },
          { sha: 'b', action: 'split' },
          { sha: 'c', action },
          { sha: 'd', action: 'pick' },
        ]),
      ).toMatch(/cannot have other commits folded into it/);
    }
    // A drop in between is no fold.
    expect(
      validateRewrite([
        { sha: 'a', action: 'pick' },
        { sha: 'b', action: 'split' },
        { sha: 'c', action: 'drop' },
        { sha: 'd', action: 'pick' },
      ]),
    ).toBeUndefined();
  });
});
