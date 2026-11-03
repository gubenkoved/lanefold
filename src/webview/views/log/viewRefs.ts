import { isHideableRef, type RefInfo, type ViewConfig } from '../../../shared/models';

/**
 * Which refs a log view shows (the branches pane's checkboxes), and the view that shows one
 * more or one fewer. Every scope keeps its kind: 'all' and 'local' leave refs out with
 * `hidden`, 'head' and 'local' add refs with `extra`, and a view of chosen refs lists them.
 * Also how views and lists name and order refs.
 */

/** Whether a view shows a ref (its commits); `fixed`: why that cannot change from here. */
export interface RefShown {
  readonly shown: boolean;
  readonly fixed?: string;
}

/** The names a view of chosen refs may list a ref by. */
function namesOf(ref: RefInfo): string[] {
  return ref.isHead ? [ref.short, ref.name, 'HEAD'] : [ref.short, ref.name];
}

function isPattern(entry: string): boolean {
  return entry.includes('*') || entry.includes('?');
}

/** Whether a pattern of a view of chosen refs (`feature/*`, as git's --glob reads it) takes a ref. */
function patternTakes(pattern: string, ref: RefInfo): boolean {
  const full = pattern.startsWith('refs/') ? pattern : `refs/heads/${pattern}`;
  const source = full
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(ref.name);
}

/** How a ref is listed in a view of chosen refs: by its short name, unless another ref has it too. */
function entryFor(ref: RefInfo, refs: readonly RefInfo[]): string {
  return refs.some((other) => other.name !== ref.name && other.short === ref.short) ? ref.name : ref.short;
}

/** Whether `view` shows `ref`, and whether its checkbox can change that. */
export function refShown(view: ViewConfig, ref: RefInfo): RefShown {
  const { scope } = view;
  if (!isHideableRef(ref.name)) return { shown: false, fixed: 'Lanefold cannot show this ref by itself' };
  const hidden = view.hidden ?? [];
  const extra = view.extra ?? [];
  // HEAD is part of these views: its branch's commits stay, whatever its checkbox would say.
  const head = 'The branch checked out is always shown here';
  switch (scope.type) {
    case 'all':
      return ref.isHead ? { shown: true, fixed: head } : { shown: !hidden.includes(ref.name) };
    case 'local':
      if (ref.isHead) return { shown: true, fixed: head };
      return ref.kind === 'branch'
        ? { shown: !hidden.includes(ref.name) }
        : { shown: extra.includes(ref.name) };
    case 'head':
      return ref.isHead ? { shown: true, fixed: head } : { shown: extra.includes(ref.name) };
    case 'refs': {
      const names = namesOf(ref);
      const listed = scope.refs.filter((entry) => names.includes(entry));
      if (listed.length > 0) {
        const others = scope.refs.length - listed.length;
        return others > 0 ? { shown: true } : { shown: true, fixed: 'A view shows one branch at least' };
      }
      const pattern = scope.refs.find((entry) => isPattern(entry) && patternTakes(entry, ref));
      return pattern ? { shown: true, fixed: `Shown for the pattern ${pattern}` } : { shown: false };
    }
  }
}

/** A list with `name` in it or not (undefined when it ends up empty). */
function withName(list: readonly string[] | undefined, name: string, present: boolean): string[] | undefined {
  const next = (list ?? []).filter((item) => item !== name);
  if (present) next.push(name);
  return next.length > 0 ? next.sort() : undefined;
}

/**
 * `view` with `ref` shown or not (the same view when its checkbox is fixed). `refs`: every ref
 * of the repository, to name the ref unambiguously in a view of chosen refs.
 */
export function withRef(view: ViewConfig, ref: RefInfo, show: boolean, refs: readonly RefInfo[]): ViewConfig {
  const state = refShown(view, ref);
  if (state.fixed || state.shown === show) return view;
  const { scope } = view;
  switch (scope.type) {
    case 'all':
      return { ...view, hidden: withName(view.hidden, ref.name, !show) };
    case 'local':
      return ref.kind === 'branch'
        ? { ...view, hidden: withName(view.hidden, ref.name, !show) }
        : { ...view, extra: withName(view.extra, ref.name, show) };
    case 'head':
      return { ...view, extra: withName(view.extra, ref.name, show) };
    case 'refs': {
      const names = namesOf(ref);
      const kept = scope.refs.filter((entry) => !names.includes(entry));
      return { ...view, scope: { type: 'refs', refs: show ? [...kept, entryFor(ref, refs)] : kept } };
    }
  }
}

/** A ref's name as views list it ("main", "origin/main", "v1.0"), from its full name. */
export function shortRefName(name: string): string {
  return name.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

const SCOPE_LABELS = { all: 'All branches', head: 'Current branch', local: 'Local branches' } as const;

/** What a view shows, in a few words: "Current branch + main", "Local branches +3", "main, dev". */
export function viewLabel(view: ViewConfig): string {
  const { scope } = view;
  if (scope.type === 'refs')
    return scope.refs.length <= 2 ? scope.refs.join(', ') : `${scope.refs[0]} +${scope.refs.length - 1} more`;
  const label = SCOPE_LABELS[scope.type];
  const extra = scope.type === 'all' ? [] : (view.extra ?? []);
  if (extra.length === 0) return label;
  return extra.length === 1 ? `${label} + ${shortRefName(extra[0]!)}` : `${label} +${extra.length}`;
}

/**
 * Branches in the order they are looked for: the current one, the trunk, the other local
 * branches, then remote branches (the trunk's first); each by name.
 */
export function orderBranches(refs: readonly RefInfo[], trunk: string | undefined): RefInfo[] {
  const rank = (ref: RefInfo) =>
    ref.kind === 'branch'
      ? ref.isHead
        ? 0
        : ref.short === trunk
          ? 1
          : 2
      : trunk && ref.short.endsWith(`/${trunk}`)
        ? 3
        : 4;
  return refs
    .filter((ref) => ref.kind !== 'tag')
    .sort((a, b) => rank(a) - rank(b) || a.short.localeCompare(b.short));
}
