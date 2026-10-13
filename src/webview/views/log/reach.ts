import type { GraphTopology } from '../../../shared/graph/topology';
import type { RefsSnapshot } from '../../../shared/models';
import { shortSha } from '../../graph/format';

/*
 * What the checked-out history holds, read off the loaded graph (nothing here asks git): whether
 * HEAD already has a commit, and why the history editor cannot reach one. Menus use it to disable
 * what would do nothing, and to say why.
 */

/** The parts of a log model read here (a LogModel is one); a filtered model is read through its source. */
export interface HistoryGraph {
  readonly topology: GraphTopology;
  readonly refs: RefsSnapshot;
  readonly source?: HistoryGraph | undefined;
}

/** How many commits back the history editor reaches on one line of history (its chain limit). */
const CHAIN_LIMIT = 1000;

const unfiltered = (graph: HistoryGraph): HistoryGraph => graph.source ?? graph;

/**
 * Whether `tip`'s history (`tip` included) contains every one of `shas`: true or false when the
 * loaded rows show it, undefined when they cannot (a commit not loaded, a way down that leaves
 * the history). One pass over the rows between them, however many commits are asked about.
 */
export function containsCommits(
  graph: HistoryGraph,
  tip: string,
  shas: readonly string[],
): boolean | undefined {
  const { topology } = unfiltered(graph);
  const start = topology.rowOfHex(tip);
  if (start < 0) return undefined;
  const goals: number[] = [];
  let end = start;
  for (const sha of shas) {
    const row = topology.rowOfHex(sha);
    if (row < 0) return undefined;
    // Rows list children before their parents: a commit above the tip is not in its history,
    // and every way down to one below stays between them.
    if (row < start) return false;
    goals.push(row);
    end = Math.max(end, row);
  }
  const reached = new Uint8Array(end - start + 1);
  reached[0] = 1;
  let unknown = false;
  for (let row = start; row < end; row++) {
    if (!reached[row - start]) continue;
    for (let k = 0, count = topology.parentCount(row); k < count; k++) {
      const parent = topology.parentRow(row, k);
      if (parent < 0) unknown = true;
      else if (parent <= end) reached[parent - start] = 1;
    }
  }
  if (goals.every((goal) => reached[goal - start])) return true;
  return unknown ? undefined : false;
}

/** Whether what is checked out already has a commit, or all of some (undefined when the graph cannot tell). */
export function headContains(graph: HistoryGraph, shas: string | readonly string[]): boolean | undefined {
  const head = unfiltered(graph).refs.head.sha;
  return head ? containsCommits(graph, head, typeof shas === 'string' ? [shas] : shas) : false;
}

/** The newest merge on HEAD's first-parent line (within the editor's reach): where editing stops. */
export function lastMerge(graph: HistoryGraph): string | undefined {
  const { topology, refs } = unfiltered(graph);
  let row = refs.head.sha ? topology.rowOfHex(refs.head.sha) : -1;
  for (let steps = 0; row >= 0 && steps <= CHAIN_LIMIT; steps++) {
    const parents = topology.parentCount(row);
    if (parents > 1) return topology.oidHex(row);
    if (parents === 0) return undefined;
    row = topology.parentRow(row, 0);
  }
  return undefined;
}

/**
 * A branch whose recent line of history (back to its last merge) has `sha`: where the history
 * editor would reach it. Local branches first, then the nearest tip.
 */
function branchWith(graph: HistoryGraph, sha: string): string | undefined {
  const { topology, refs } = graph;
  const goal = topology.rowOfHex(sha);
  if (goal < 0) return undefined;
  let best: { name: string; distance: number; remote: boolean } | undefined;
  for (const ref of refs.refs) {
    if ((ref.kind !== 'branch' && ref.kind !== 'remote') || ref.isHead || ref.short.endsWith('/HEAD'))
      continue;
    const remote = ref.kind === 'remote';
    let row = topology.rowOfHex(ref.target);
    for (let distance = 0; row >= 0 && row <= goal && distance < CHAIN_LIMIT; distance++) {
      if (topology.parentCount(row) > 1) break;
      if (row === goal) {
        if (!best || (best.remote && !remote) || (best.remote === remote && distance < best.distance))
          best = { name: ref.short, distance, remote };
        break;
      }
      if (topology.parentCount(row) === 0) break;
      row = topology.parentRow(row, 0);
    }
  }
  return best?.name;
}

const WORDS = {
  edit: { doing: 'Editing', verb: 'edit', done: 'edited' },
  amend: { doing: 'Amending', verb: 'amend', done: 'amended' },
} as const;

/**
 * Why the history editor cannot reach `sha` (undefined when it can): `editable` is what it
 * reaches, the current branch back to its last merge (see entryPoints' `editableHistory`).
 */
export function editBlocker(
  graph: HistoryGraph,
  sha: string,
  editable: { has(sha: string): boolean; readonly size: number },
  what: keyof typeof WORDS = 'edit',
): string | undefined {
  if (editable.has(sha)) return undefined;
  const source = unfiltered(graph);
  const { head } = source.refs;
  const current = head.branch ?? 'HEAD';
  const words = WORDS[what];
  if (!head.sha) return `${current} has no commits yet`;
  const row = source.topology.rowOfHex(sha);
  if (row >= 0 && source.topology.parentCount(row) > 1) return `Merge commits can’t be ${words.done} here`;
  const contained = headContains(source, sha);
  if (contained) {
    const merge = lastMerge(source);
    return merge
      ? `${words.doing} reaches back to the last merge, ${shortSha(merge)}`
      : `${words.doing} reaches back ${editable.size.toLocaleString()} commits`;
  }
  const branch = contained === false ? branchWith(source, sha) : undefined;
  return branch
    ? `Check out ${branch} to ${words.verb} it`
    : `Only commits of ${current} since its last merge can be ${words.done}`;
}
