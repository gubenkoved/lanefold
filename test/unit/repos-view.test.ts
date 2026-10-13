import { beforeEach, describe, expect, it } from 'vitest';
import { assignColorSlots, preferredSlot, REPO_HUES } from '../../src/webview/graph/repoColorSlots';
import { adoptSharedTab, noteSharedTab, sharedTab, withSharedTab } from '../../src/webview/state/sharedTab';
import { CONSOLE_TAB_ID, type TabModel, type TabsState } from '../../src/webview/state/tabs';

const log = (id: string): TabModel => ({ id, kind: 'log', title: id, view: { scope: { type: 'all' } } });
const repos = (id: string, title = 'All repositories'): TabModel => ({
  id,
  kind: 'repos',
  title,
  view: { scope: { type: 'all' } },
});
const consoleTab: TabModel = { id: CONSOLE_TAB_ID, kind: 'console', title: 'Console' };
const ids = (state: TabsState) => state.tabs.map((tab) => tab.id);

describe('the tab every repository shares', () => {
  beforeEach(() => adoptSharedTab(undefined));

  it('joins each repository’s tabs: where that repository had it, else before the Console', () => {
    adoptSharedTab(repos('r1'));
    const elsewhere = withSharedTab({ tabs: [log('a'), log('b'), consoleTab], activeTabId: 'b' });
    expect(ids(elsewhere)).toEqual(['a', 'b', 'r1', CONSOLE_TAB_ID]);
    expect(elsewhere.activeTabId).toBe('b');
    // A repository that moved it keeps it there, with what it shows now.
    const moved = withSharedTab({
      tabs: [repos('r1', 'Old title'), log('a'), consoleTab],
      activeTabId: 'r1',
    });
    expect(ids(moved)).toEqual(['r1', 'a', CONSOLE_TAB_ID]);
    expect(moved.tabs[0]).toBe(sharedTab());
    expect(moved.activeTabId).toBe('r1');
  });

  it('leaves out copies of one that was closed or replaced', () => {
    adoptSharedTab(null);
    const state = withSharedTab({ tabs: [log('a'), repos('old'), consoleTab], activeTabId: 'old' });
    expect(ids(state)).toEqual(['a', CONSOLE_TAB_ID]);
    expect(state.activeTabId).toBe('a');
    adoptSharedTab(repos('new'));
    expect(ids(withSharedTab({ tabs: [repos('old'), log('a')], activeTabId: 'a' }))).toEqual(['a', 'new']);
  });

  it('is saved apart when it is added, changed or closed, not when other tabs change', () => {
    const saved: (TabModel | null)[] = [];
    const save = (tab: TabModel | null) => saved.push(tab);
    const added = { tabs: [log('a'), repos('r1')], activeTabId: 'r1' };
    noteSharedTab(added, save);
    noteSharedTab({ ...added, activeTabId: 'a' }, save);
    noteSharedTab({ tabs: [added.tabs[1]!, log('a')], activeTabId: 'a' }, save);
    expect(saved).toEqual([repos('r1')]);
    const renamed = repos('r1', 'Everything');
    noteSharedTab({ tabs: [log('a'), renamed], activeTabId: 'a' }, save);
    noteSharedTab({ tabs: [log('a')], activeTabId: 'a' }, save);
    expect(saved).toEqual([repos('r1'), renamed, null]);
    expect(sharedTab()).toBeUndefined();
  });

  it('only takes a valid stored tab of its kind', () => {
    adoptSharedTab({
      id: 'x',
      kind: 'repos',
      title: 'All',
      view: { scope: { type: 'refs', refs: ['main'] } },
    });
    expect(sharedTab()).toBeUndefined();
    adoptSharedTab(log('a'));
    expect(sharedTab()).toBeUndefined();
    adoptSharedTab({ ...repos('r1'), hiddenRepos: ['/w/a'] });
    expect(sharedTab()).toMatchObject({ id: 'r1', hiddenRepos: ['/w/a'] });
  });
});

describe('repository colors', () => {
  const keys = (count: number, prefix = '/w/repo') =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}/.git`);

  it('gives up to twelve repositories distinct hues, and up to four hues that are not neighbours', () => {
    for (let count = 2; count <= REPO_HUES; count++) {
      const slots = assignColorSlots(keys(count), new Map());
      expect(new Set(slots).size).toBe(count);
      expect(slots.every((slot) => slot >= 0 && slot < REPO_HUES)).toBe(true);
    }
    for (let trial = 0; trial < 40; trial++) {
      const slots = assignColorSlots(keys(4, `/t${trial}/r`), new Map());
      for (const a of slots)
        for (const b of slots)
          if (a !== b) expect(Math.min((a - b + 12) % 12, (b - a + 12) % 12)).toBeGreaterThan(1);
    }
  });

  it('does not depend on the order repositories are listed in', () => {
    const list = keys(6);
    const forward = assignColorSlots(list, new Map());
    const backward = assignColorSlots([...list].reverse(), new Map()).reverse();
    expect(backward).toEqual(forward);
  });

  it('keeps every repository’s color while others open and close', () => {
    const given = new Map<string, number>();
    const first = assignColorSlots(['/w/a/.git', '/w/b/.git'], given);
    const more = assignColorSlots(['/w/a/.git', '/w/sub/.git', '/w/b/.git', '/w/c/.git'], given);
    expect([more[0], more[2]]).toEqual(first);
    const fewer = assignColorSlots(['/w/c/.git', '/w/b/.git'], given);
    expect(fewer).toEqual([more[3], more[2]]);
    // A repository that closed gives its slot back.
    expect([...given.keys()].sort()).toEqual(['/w/b/.git', '/w/c/.git']);
  });

  it('starts from the hue its git directory hashes to', () => {
    const key = '/w/only/.git';
    expect(assignColorSlots([key], new Map())).toEqual([preferredSlot(key)]);
  });

  it('reuses hues, in another lightness, beyond twelve repositories', () => {
    const slots = assignColorSlots(keys(14), new Map());
    expect(slots.filter((slot) => slot >= REPO_HUES)).toHaveLength(2);
  });
});
