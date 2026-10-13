import { describe, expect, it } from 'vitest';
import {
  compareTitle,
  HEAD_TITLE,
  plainLogTab,
  tabTitle,
  tabTitles,
  type TabModel,
} from '../../src/webview/state/tabs';

const log = (id: string, title: string, view: TabModel['view'], search?: string): TabModel => ({
  id,
  kind: 'log',
  title,
  view,
  search,
});

const all = log('a', 'All', { scope: { type: 'all' } });
const current = log('h', HEAD_TITLE, { scope: { type: 'head' } });
const consoleView = { id: 'console', kind: 'console', title: 'Console' } as const satisfies TabModel;

describe('tab titles', () => {
  it('names the current-branch view after the branch checked out, until it is renamed', () => {
    expect(tabTitle(current, 'main')).toBe('main');
    expect(tabTitle(current, undefined)).toBe('HEAD');
    expect(tabTitle({ ...current, title: 'Mine' }, 'main')).toBe('Mine');
    // Other views keep their titles, whatever their scope.
    expect(tabTitle(log('m', 'HEAD', { scope: { type: 'refs', refs: ['HEAD'] } }), 'main')).toBe('HEAD');
    expect(tabTitle(all, 'main')).toBe('All');
  });

  it('never shows two tabs alike: later ones are numbered', () => {
    const tabs = [
      all,
      current,
      log('b', 'main', { scope: { type: 'refs', refs: ['main'] } }),
      log('c', 'All', { scope: { type: 'all' }, hidden: ['refs/heads/old'] }),
      log('d', 'All 2', { scope: { type: 'local' } }),
      consoleView,
    ];
    expect([...tabTitles(tabs, 'main').values()]).toEqual([
      'All',
      'main',
      'main 2',
      'All 3',
      'All 2',
      'Console',
    ]);
  });
});

describe('finding a view', () => {
  it('finds the tab that shows a scope as it comes', () => {
    const filtered = log('f', 'All', { scope: { type: 'all' }, hidden: ['refs/heads/x'] });
    const searched = log('s', 'Local', { scope: { type: 'local' } }, '@carol');
    const file = log('p', 'a.ts', { scope: { type: 'head' }, paths: ['a.ts'] });
    const branch = log('r', 'main', { scope: { type: 'refs', refs: ['main'] } });
    const tabs = [filtered, searched, file, all, current, branch, consoleView];
    expect(plainLogTab(tabs, { type: 'all' })).toBe(all);
    expect(plainLogTab(tabs, { type: 'head' })).toBe(current);
    expect(plainLogTab(tabs, { type: 'local' })).toBeUndefined();
    expect(plainLogTab(tabs, { type: 'refs', refs: ['main'] })).toBe(branch);
    expect(plainLogTab(tabs, { type: 'refs', refs: ['main', 'feature'] })).toBeUndefined();
  });

  it('titles a comparison once both sides are chosen', () => {
    expect(compareTitle({ a: 'main', b: '', mode: 'three-dot' })).toBe('Compare');
    expect(compareTitle({ a: 'main', b: 'a'.repeat(40), mode: 'two-dot' })).toBe('main ↔ aaaaaaaa');
  });
});
