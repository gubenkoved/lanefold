import { EDGE_ELIDED, EDGE_MISSING, GraphLayout, type LayoutOptions } from '../../src/shared/graph/layout';
import { GraphTopology } from '../../src/shared/graph/topology';

/** A commit in a test graph: name plus parent names (first parent first). */
export type CommitSpec = readonly [name: string, parents: readonly string[]];

/** Deterministic fake object ID for a commit name. */
export function fakeOid(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return (hex + 'a'.repeat(32)).slice(0, 40);
}

/** Builds a topology from rows given in display order (children before parents). */
export function buildTopology(
  commits: readonly CommitSpec[],
  complete = true,
): { topo: GraphTopology; ids: Map<string, number> } {
  const topo = new GraphTopology(20);
  const ids = new Map<string, number>();
  const idOf = (name: string) => {
    let id = ids.get(name);
    if (id === undefined) {
      id = topo.addOidHex(fakeOid(name));
      ids.set(name, id);
    }
    return id;
  };
  for (const [name, parents] of commits) {
    const id = idOf(name);
    topo.appendRow(id, parents.map(idOf));
  }
  topo.complete = complete;
  return { topo, ids };
}

export function layoutOf(commits: readonly CommitSpec[], options: Partial<LayoutOptions> = {}) {
  const { topo, ids } = buildTopology(commits);
  const layout = new GraphLayout(topo, { elideAfter: Infinity, paletteSize: 10, ...options });
  layout.run();
  return { topo, ids, layout };
}

/** Readable summary: one line per row ("A@0") and one per edge ("A→B 0→1 via 1"). */
export function summarizeLayout(
  layout: GraphLayout,
  names: readonly string[],
): { nodes: string[]; edges: string[] } {
  const topo = layout.topology;
  const nameOfId = new Map<number, string>();
  for (let row = 0; row < topo.rowCount; row++) nameOfId.set(topo.rowId(row), names[row]!);
  const nodes: string[] = [];
  for (let row = 0; row < layout.rowsDone; row++) nodes.push(`${names[row]}@${layout.nodeLane[row]}`);
  const edges: string[] = [];
  const e = layout.edges;
  for (let id = 0; id < e.count; id++) {
    const from = names[e.fromRow[id]!];
    const to = nameOfId.get(e.target[id]!) ?? '?';
    let text = `${from}→${to} ${e.fromLane[id]}→${e.toLane[id]} via ${e.travel[id]}`;
    if (e.flags[id]! & EDGE_ELIDED) text += ' elided';
    if (e.flags[id]! & EDGE_MISSING) text += ' missing';
    edges.push(text);
  }
  return { nodes, edges };
}

/** Small deterministic PRNG for property tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Generates a plausible repository history (branches, merges, octopus merges, multiple roots)
 * and returns it in a valid display order (every commit before its parents).
 */
export function randomHistory(seed: number, size: number): { commits: CommitSpec[]; trunkTip: string } {
  const random = rng(seed);
  const parents = new Map<string, string[]>();
  const order: string[] = [];
  let next = 0;
  const create = (ps: string[]) => {
    const name = `c${next++}`;
    parents.set(name, ps);
    order.push(name);
    return name;
  };
  const trunk = { tip: create([]) };
  const branches: string[] = [];
  while (next < size) {
    const roll = random();
    if (roll < 0.45) {
      trunk.tip = create([trunk.tip]);
    } else if (roll < 0.6 || branches.length === 0) {
      // Branch off a recent commit.
      const base = order[Math.max(0, order.length - 1 - Math.floor(random() * Math.min(order.length, 30)))]!;
      branches.push(create([base]));
    } else if (roll < 0.85) {
      const i = Math.floor(random() * branches.length);
      branches[i] = create([branches[i]!]);
    } else if (roll < 0.97) {
      const i = Math.floor(random() * branches.length);
      trunk.tip = create([trunk.tip, branches[i]!]);
      branches.splice(i, 1);
    } else if (roll < 0.99 && branches.length >= 2) {
      const merged = branches.splice(0, 2);
      trunk.tip = create([trunk.tip, ...merged]);
    } else {
      branches.push(create([])); // an extra root (orphan branch)
    }
  }
  // Display order: newest first is a valid children-before-parents order here.
  const commits = order
    .slice()
    .reverse()
    .map((name): CommitSpec => [name, parents.get(name)!]);
  return { commits, trunkTip: trunk.tip };
}
