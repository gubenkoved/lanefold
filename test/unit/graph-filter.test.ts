import { describe, expect, it } from 'vitest';
import { filterTopology } from '../../src/shared/graph/filter';
import { GraphLayout } from '../../src/shared/graph/layout';
import type { GraphTopology } from '../../src/shared/graph/topology';
import { buildTopology, type CommitSpec } from './graph-helpers';

/** Rows of the filtered topology as "name: parent names". */
function summarize(filtered: GraphTopology, ids: Map<string, number>): string[] {
  const names = new Map([...ids].map(([name, id]) => [id, name]));
  const lines: string[] = [];
  for (let row = 0; row < filtered.rowCount; row++) {
    const parents: string[] = [];
    for (let k = 0; k < filtered.parentCount(row); k++) parents.push(names.get(filtered.parentId(row, k))!);
    lines.push(`${names.get(filtered.rowId(row))}: ${parents.join(' ')}`);
  }
  return lines;
}

function filter(commits: readonly CommitSpec[], keepNames: readonly string[], maxParents?: number) {
  const { topo, ids } = buildTopology(commits);
  const keep = new Uint8Array(topo.rowCount);
  commits.forEach(([name], row) => (keep[row] = keepNames.includes(name) ? 1 : 0));
  return summarize(filterTopology(topo, keep, maxParents), ids);
}

describe('filterTopology', () => {
  it('connects kept commits through skipped ones on a line', () => {
    const line: CommitSpec[] = [
      ['e', ['d']],
      ['d', ['c']],
      ['c', ['b']],
      ['b', ['a']],
      ['a', []],
    ];
    expect(filter(line, ['e', 'c', 'a'])).toEqual(['e: c', 'c: a', 'a: ']);
    expect(filter(line, ['d'])).toEqual(['d: ']);
  });

  it('keeps both sides of a merge when they lead to different kept commits', () => {
    // m merges f (feature) into t (trunk); both branch off r.
    const graph: CommitSpec[] = [
      ['m', ['t', 'f']],
      ['t', ['t0']],
      ['f', ['f0']],
      ['t0', ['r']],
      ['f0', ['r']],
      ['r', []],
    ];
    expect(filter(graph, ['m', 't0', 'f0', 'r'])).toEqual(['m: t0 f0', 't0: r', 'f0: r', 'r: ']);
    // Both sides reach the same kept commit: the merge collapses to one parent.
    expect(filter(graph, ['m', 'r'])).toEqual(['m: r', 'r: ']);
  });

  it('keeps edges to parents outside the loaded history', () => {
    const { topo, ids } = buildTopology([
      ['b', ['a']],
      ['a', ['outside']],
    ]);
    const filtered = filterTopology(topo, Uint8Array.of(0, 1));
    expect(summarize(filtered, ids)).toEqual(['a: outside']);
  });

  it('caps the number of rewritten parents', () => {
    const octopus: CommitSpec[] = [
      ['o', ['p1', 'p2', 'p3', 'p4']],
      ['p1', []],
      ['p2', []],
      ['p3', []],
      ['p4', []],
    ];
    expect(filter(octopus, ['o', 'p1', 'p2', 'p3', 'p4'], 2)).toEqual([
      'o: p1 p2',
      'p1: ',
      'p2: ',
      'p3: ',
      'p4: ',
    ]);
  });

  it('produces a topology the layout accepts', () => {
    const { topo } = buildTopology([
      ['m', ['t', 'f']],
      ['t', ['r']],
      ['f', ['r']],
      ['r', []],
    ]);
    const filtered = filterTopology(topo, Uint8Array.of(1, 0, 1, 1));
    const layout = new GraphLayout(filtered, { elideAfter: Infinity, paletteSize: 10 });
    layout.run();
    expect(layout.rowsDone).toBe(3);
    expect(layout.finalized).toBe(true);
  });
});
