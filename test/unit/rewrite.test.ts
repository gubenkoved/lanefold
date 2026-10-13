import { describe, expect, it } from 'vitest';
import {
  autosquash,
  autosquashCandidates,
  cleanMessage,
  defaultGroupMessage,
  firstChange,
  foldInto,
  groupMessage,
  groupRewrite,
  layoutTodo,
  normalizeRewrite,
  pickAll,
  renderTodo,
  rewriteProblem,
  squashSelection,
  validateRewrite,
  type RewriteCommit,
  type RewriteEntry,
} from '../../src/shared/rewrite';

const shas = ['a', 'b', 'c', 'd', 'e'];
const messages: Record<string, string> = { a: 'A', b: 'B\n\nbody of B', c: 'C', d: 'D', e: 'E' };
const messageOf = (sha: string) => messages[sha];
const picks = () => pickAll(shas.map((sha) => ({ sha })));

describe('rewrite model', () => {
  it('groups squash and fixup entries into the previous kept commit, skipping drops', () => {
    const entries: RewriteEntry[] = [
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'drop' },
      { sha: 'c', action: 'fixup' },
      { sha: 'd', action: 'reword', message: 'D!' },
      { sha: 'e', action: 'squash' },
    ];
    const groups = groupRewrite(entries);
    expect(groups.map((g) => [g.head.sha, g.members.map((m) => m.sha), g.newMessage])).toEqual([
      ['a', ['c'], false],
      ['d', ['e'], true],
    ]);
    expect(groupMessage(groups[0]!, messageOf)).toBe('A');
    expect(groupMessage(groups[1]!, messageOf)).toBe('D!');
  });

  it('combines messages of squashed commits but not of fixups', () => {
    const [group] = groupRewrite([
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'squash' },
      { sha: 'c', action: 'fixup' },
    ]);
    expect(defaultGroupMessage(group!, messageOf)).toBe('A\n\nB\n\nbody of B');
  });

  it('validates arrangements', () => {
    expect(validateRewrite([])).toMatch(/no commits/);
    expect(validateRewrite([{ sha: 'a', action: 'squash' }])).toMatch(/oldest remaining commit/);
    expect(
      validateRewrite([
        { sha: 'a', action: 'drop' },
        { sha: 'b', action: 'fixup' },
      ]),
    ).toMatch(/oldest remaining commit/);
    expect(validateRewrite([{ sha: 'a', action: 'reword', message: '  \n' }])).toMatch(/needs a message/);
    expect(
      validateRewrite([
        { sha: 'a', action: 'pick' },
        { sha: 'a', action: 'pick' },
      ]),
    ).toMatch(/twice/);
    expect(validateRewrite(picks())).toBeUndefined();
  });

  it('names the commit a problem is about, and what kind it is (for the editor to point at it)', () => {
    const kind = (entries: RewriteEntry[], fromRoot = false) => {
      const problem = rewriteProblem(entries, { fromRoot });
      return problem && [problem.kind, problem.sha];
    };
    expect(kind([])).toEqual(['empty', undefined]);
    // The first commit that stays, past the dropped ones.
    expect(
      kind([
        { sha: 'a', action: 'drop' },
        { sha: 'b', action: 'squash' },
        { sha: 'c', action: 'pick' },
      ]),
    ).toEqual(['squash-first', 'b']);
    expect(
      kind([
        { sha: 'a', action: 'pick' },
        { sha: 'a', action: 'drop' },
      ]),
    ).toEqual(['duplicate', 'a']);
    expect(kind([{ sha: 'a', action: 'split' }], true)).toEqual(['split-root', 'a']);
    expect(kind([{ sha: 'a', action: 'split' }])).toBeUndefined();
    expect(
      kind([
        { sha: 'a', action: 'pick' },
        { sha: 'b', action: 'split' },
        { sha: 'c', action: 'fixup' },
      ]),
    ).toEqual(['split-folded', 'b']);
    // A message left empty: the commit whose message it is (a group's head).
    expect(
      kind([
        { sha: 'a', action: 'pick' },
        { sha: 'b', action: 'reword', message: ' ' },
      ]),
    ).toEqual(['no-message', 'b']);
    expect(
      kind([
        { sha: 'a', action: 'pick', message: '' },
        { sha: 'b', action: 'squash' },
      ]),
    ).toEqual(['no-message', 'a']);
    expect(kind(picks())).toBeUndefined();
    // Nothing left of the whole history (after a base, the branch just goes back to it).
    const drops: RewriteEntry[] = shas.map((sha) => ({ sha, action: 'drop' }));
    expect(kind(drops, true)).toEqual(['nothing-left', undefined]);
    expect(kind(drops)).toBeUndefined();
    // The words are validateRewrite's.
    const problem = rewriteProblem([{ sha: 'a', action: 'fixup' }]);
    expect(problem?.message).toBe(validateRewrite([{ sha: 'a', action: 'fixup' }]));
  });

  it('cleans messages like git does without an editor', () => {
    expect(cleanMessage('\n\n  Subject  \r\n\n\n\nBody line   \n\n')).toBe('  Subject\n\nBody line');
    expect(cleanMessage(' \n ')).toBe('');
  });

  it('normalizes rewords to the same message into picks', () => {
    expect(
      normalizeRewrite(
        [
          { sha: 'a', action: 'reword', message: 'A\n' },
          { sha: 'b', action: 'reword', message: 'New B ' },
          { sha: 'c', action: 'drop', message: 'ignored' },
        ],
        messageOf,
      ),
    ).toEqual([
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'reword', message: 'New B' },
      { sha: 'c', action: 'drop' },
    ]);
  });

  it('finds the first entry that changes the history', () => {
    expect(firstChange(picks(), shas)).toBe(5);
    const reordered = picks();
    [reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
    expect(firstChange(reordered, shas)).toBe(2);
    // A pick that gets something folded into it changes.
    expect(firstChange(squashSelection(picks(), new Set(['b', 'e'])), shas)).toBe(1);
    // Dropping only the newest commit changes nothing before it.
    expect(firstChange([...picks().slice(0, 4), { sha: 'e', action: 'drop' }], shas)).toBe(4);
  });

  it('squashes a scattered selection into its oldest commit', () => {
    expect(squashSelection(picks(), new Set(['e', 'b', 'd']))).toEqual([
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'pick' },
      { sha: 'd', action: 'squash' },
      { sha: 'e', action: 'squash' },
      { sha: 'c', action: 'pick' },
    ]);
  });

  it('folds a commit into another, moving it right after its target', () => {
    expect(foldInto(picks(), 'e', 'b', 'fixup').map((e) => `${e.action} ${e.sha}`)).toEqual([
      'pick a',
      'pick b',
      'fixup e',
      'pick c',
      'pick d',
    ]);
  });

  it('lays out the todo with carriers, drops last, and anchors for update-ref', () => {
    const entries: RewriteEntry[] = [
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'squash' },
      { sha: 'c', action: 'drop' },
      { sha: 'd', action: 'edit' },
      { sha: 'e', action: 'reword', message: 'E2' },
    ];
    const layout = layoutTodo(entries, (group) => `carrier-${group.head.sha}`, shas);
    expect(layout.lines).toEqual([
      'pick a',
      'fixup b',
      'fixup -C carrier-a',
      'edit d',
      'pick e',
      'fixup -C carrier-e',
      'drop c',
    ]);
    // A branch at the dropped c ends up where b's group ends.
    expect(layout.anchors).toEqual({ a: 2, b: 2, c: 2, d: 3, e: 5 });
    expect(renderTodo(layout, (sha) => (sha === 'c' ? ['refs/heads/topic'] : []))).toBe(
      'pick a\nfixup b\nfixup -C carrier-a\nupdate-ref refs/heads/topic\nedit d\npick e\nfixup -C carrier-e\ndrop c\n',
    );
  });

  it('anchors refs before everything when all older commits are dropped', () => {
    const layout = layoutTodo(
      [
        { sha: 'a', action: 'drop' },
        { sha: 'b', action: 'pick' },
      ],
      () => 'x',
      ['a', 'b'],
    );
    expect(renderTodo(layout, (sha) => (sha === 'a' ? ['refs/heads/old'] : []))).toBe(
      'update-ref refs/heads/old\npick b\ndrop a\n',
    );
  });
});

describe('autosquash', () => {
  const commit = (sha: string, subject: string, body = ''): RewriteCommit => ({
    sha,
    parents: [],
    authorName: 'A',
    authorEmail: 'a@x',
    authorTime: 0,
    subject,
    message: body ? `${subject}\n\n${body}` : subject,
  });

  it('moves fixup!, squash! and amend! commits after their targets, in order', () => {
    const commits = [
      commit('a1', 'Add parser'),
      commit('b2', 'Add lexer'),
      commit('c3', 'fixup! Add parser'),
      commit('d4', 'squash! Add lexer'),
      commit('e5', 'fixup! fixup! Add parser'),
      commit('f6', 'amend! Add lexer', 'Add a faster lexer'),
      commit('g7', 'fixup! nothing like this'),
    ];
    const result = autosquash(pickAll(commits), commits);
    expect(result.map((e) => `${e.action} ${e.sha}${e.message ? ` "${e.message}"` : ''}`)).toEqual([
      'pick a1',
      'fixup c3',
      'fixup e5',
      'reword b2 "Add a faster lexer"',
      'squash d4',
      'fixup f6',
      'pick g7',
    ]);
    expect(autosquashCandidates(commits)).toBe(5);
  });

  it('matches a hash prefix and subject prefixes', () => {
    const commits = [
      commit('abcdef12', 'Refactor the storage layer'),
      commit('99', 'fixup! abcdef'),
      commit('98', 'fixup! Refactor the'),
    ];
    expect(autosquash(pickAll(commits), commits).map((e) => `${e.action} ${e.sha}`)).toEqual([
      'pick abcdef12',
      'fixup 99',
      'fixup 98',
    ]);
  });
});
