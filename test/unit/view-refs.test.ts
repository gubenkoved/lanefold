import { describe, expect, it } from 'vitest';
import type { RefInfo, ViewConfig } from '../../src/shared/models';
import { orderBranches, refShown, viewLabel, withRef } from '../../src/webview/views/log/viewRefs';

const sha = (n: number) => n.toString(16).padStart(40, '0');

function ref(name: string, extra: Partial<RefInfo> = {}): RefInfo {
  const [, kind, short] = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(name)!;
  return {
    name,
    short: short!,
    kind: kind === 'heads' ? 'branch' : kind === 'remotes' ? 'remote' : 'tag',
    target: sha(name.length),
    ...extra,
  };
}

const main = ref('refs/heads/main', { isHead: true });
const dev = ref('refs/heads/dev');
const originDev = ref('refs/remotes/origin/dev');
const tag = ref('refs/tags/v1.0');
const REFS = [main, dev, originDev, tag];

const all: ViewConfig = { scope: { type: 'all' } };
const local: ViewConfig = { scope: { type: 'local' } };
const head: ViewConfig = { scope: { type: 'head' } };
const chosen = (...refs: string[]): ViewConfig => ({ scope: { type: 'refs', refs } });

describe('refShown', () => {
  it('shows every ref of an all-branches view but the hidden ones', () => {
    expect(refShown(all, dev)).toEqual({ shown: true });
    expect(refShown({ ...all, hidden: [dev.name] }, dev)).toEqual({ shown: false });
    // HEAD is part of the view: its branch cannot be left out.
    expect(refShown({ ...all, hidden: [main.name] }, main)).toMatchObject({
      shown: true,
      fixed: expect.any(String),
    });
  });

  it('shows local branches, and other refs only when added', () => {
    expect(refShown(local, dev)).toEqual({ shown: true });
    expect(refShown(local, originDev)).toEqual({ shown: false });
    expect(refShown({ ...local, extra: [originDev.name] }, originDev)).toEqual({ shown: true });
  });

  it('shows the current branch, and others only when added', () => {
    expect(refShown(head, main)).toMatchObject({ shown: true, fixed: expect.any(String) });
    expect(refShown(head, dev)).toEqual({ shown: false });
    expect(refShown({ ...head, extra: [tag.name] }, tag)).toEqual({ shown: true });
  });

  it('shows the refs a view lists, by any of their names, and those its patterns take', () => {
    expect(refShown(chosen('dev', 'origin/dev'), dev)).toEqual({ shown: true });
    expect(refShown(chosen('refs/heads/dev', 'v1.0'), dev)).toEqual({ shown: true });
    expect(refShown(chosen('HEAD', 'dev'), main)).toEqual({ shown: true });
    expect(refShown(chosen('dev'), main)).toEqual({ shown: false });
    // The last ref stays; a pattern's refs come and go with it.
    expect(refShown(chosen('dev'), dev)).toMatchObject({ shown: true, fixed: expect.any(String) });
    expect(refShown(chosen('main', 'de*'), dev)).toMatchObject({
      shown: true,
      fixed: expect.stringContaining('de*'),
    });
    expect(refShown(chosen('main', 'refs/remotes/*/dev'), originDev)).toMatchObject({ shown: true });
    expect(refShown(chosen('main', 'd.v'), dev)).toEqual({ shown: false });
  });
});

describe('withRef', () => {
  it('hides and shows again in an all-branches view', () => {
    const hidden = withRef(all, dev, false, REFS);
    expect(hidden).toEqual({ scope: { type: 'all' }, hidden: [dev.name] });
    expect(withRef(hidden, dev, true, REFS)).toEqual({ scope: { type: 'all' }, hidden: undefined });
  });

  it('hides local branches and adds other refs to a local view', () => {
    expect(withRef(local, dev, false, REFS)).toMatchObject({ scope: { type: 'local' }, hidden: [dev.name] });
    const added = withRef(local, originDev, true, REFS);
    expect(added).toMatchObject({ scope: { type: 'local' }, extra: [originDev.name] });
    expect(withRef(added, originDev, false, REFS).extra).toBeUndefined();
  });

  it('adds refs to the current branch, keeping it a current-branch view', () => {
    const view = withRef(withRef(head, tag, true, REFS), dev, true, REFS);
    expect(view).toEqual({ scope: { type: 'head' }, extra: [dev.name, tag.name] });
    // Its own branch stays.
    expect(withRef(view, main, false, REFS)).toBe(view);
  });

  it('lists and unlists chosen refs, by an unambiguous name', () => {
    const view = withRef(chosen('main'), dev, true, REFS);
    expect(view.scope).toEqual({ type: 'refs', refs: ['main', 'dev'] });
    expect(withRef(view, main, false, REFS).scope).toEqual({ type: 'refs', refs: ['dev'] });
    // A branch that shares its name with a tag goes by its full name.
    const twin = ref('refs/heads/v1.0');
    expect(withRef(chosen('main'), twin, true, [...REFS, twin]).scope).toEqual({
      type: 'refs',
      refs: ['main', 'refs/heads/v1.0'],
    });
    // Every name that lists a ref goes with it.
    expect(withRef(chosen('HEAD', 'main', 'dev'), main, false, REFS).scope).toEqual({
      type: 'refs',
      refs: ['dev'],
    });
  });

  it('changes nothing it cannot', () => {
    const view = chosen('dev');
    expect(withRef(view, dev, false, REFS)).toBe(view);
    expect(withRef(all, dev, true, REFS)).toBe(all);
  });
});

describe('viewLabel', () => {
  it('names what a view shows', () => {
    expect(viewLabel(all)).toBe('All branches');
    expect(viewLabel({ ...head, extra: ['refs/heads/main'] })).toBe('Current branch + main');
    expect(viewLabel({ ...local, extra: ['refs/remotes/origin/a', 'refs/tags/v1'] })).toBe(
      'Local branches +2',
    );
    expect(viewLabel(chosen('main', 'dev'))).toBe('main, dev');
    expect(viewLabel(chosen('main', 'dev', 'v1.0'))).toBe('main +2 more');
  });
});

describe('orderBranches', () => {
  it('puts the current branch and the trunk first, local before remote branches', () => {
    const refs = [
      ref('refs/remotes/origin/zeta'),
      ref('refs/heads/alpha'),
      ref('refs/remotes/origin/main'),
      ref('refs/tags/v1'),
      ref('refs/heads/main'),
      ref('refs/heads/topic', { isHead: true }),
    ];
    expect(orderBranches(refs, 'main').map((r) => r.short)).toEqual([
      'topic',
      'main',
      'alpha',
      'origin/main',
      'origin/zeta',
    ]);
  });
});
