import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_INTERVAL,
  EDGE_ELIDED,
  EDGE_MISSING,
  EDGE_OPEN,
  GraphLayout,
  TRUNK_COLOR,
} from '../../src/shared/graph/layout';
import { type GraphTopology } from '../../src/shared/graph/topology';
import {
  buildTopology,
  layoutOf,
  randomHistory,
  rng,
  summarizeLayout,
  type CommitSpec,
} from './graph-helpers';

const names = (commits: readonly CommitSpec[]) => commits.map(([name]) => name);

describe('GraphLayout — hand-made histories', () => {
  it('keeps a linear history in one lane', () => {
    const commits: CommitSpec[] = [
      ['C', ['B']],
      ['B', ['A']],
      ['A', []],
    ];
    const { layout } = layoutOf(commits);
    expect(summarizeLayout(layout, names(commits))).toEqual({
      nodes: ['C@0', 'B@0', 'A@0'],
      edges: ['C→B 0→0 via 0', 'B→A 0→0 via 0'],
    });
  });

  it('routes a merged feature branch in its own lane and converges at the fork point', () => {
    const commits: CommitSpec[] = [
      ['M', ['D', 'F']],
      ['F', ['E']],
      ['E', ['B']],
      ['D', ['C']],
      ['C', ['B']],
      ['B', ['A']],
      ['A', []],
    ];
    const { layout } = layoutOf(commits);
    expect(summarizeLayout(layout, names(commits))).toEqual({
      nodes: ['M@0', 'F@1', 'E@1', 'D@0', 'C@0', 'B@0', 'A@0'],
      edges: [
        'M→D 0→0 via 0',
        'M→F 0→1 via 1',
        'F→E 1→1 via 1',
        'E→B 1→0 via 1',
        'D→C 0→0 via 0',
        'C→B 0→0 via 0',
        'B→A 0→0 via 0',
      ],
    });
  });

  it('pins the trunk to lane 0 even when another branch is newer', () => {
    const commits: CommitSpec[] = [
      ['F', ['B']],
      ['D', ['B']],
      ['B', ['A']],
      ['A', []],
    ];
    const free = summarizeLayout(layoutOf(commits).layout, names(commits)).nodes;
    expect(free).toEqual(['F@0', 'D@1', 'B@0', 'A@0']);

    const { ids, topo } = buildTopology(commits);
    const layout = new GraphLayout(topo, { elideAfter: Infinity, paletteSize: 10, trunkTipId: ids.get('D') });
    layout.run();
    expect(summarizeLayout(layout, names(commits)).nodes).toEqual(['F@1', 'D@0', 'B@0', 'A@0']);
    expect(layout.nodeColor[1]).toBe(TRUNK_COLOR);
    expect(layout.nodeColor[0]).not.toBe(TRUNK_COLOR);
  });

  it('fans octopus merges out into separate lanes', () => {
    const commits: CommitSpec[] = [
      ['O', ['A', 'B', 'C']],
      ['A', []],
      ['B', []],
      ['C', []],
    ];
    const { layout } = layoutOf(commits);
    expect(summarizeLayout(layout, names(commits)).nodes).toEqual(['O@0', 'A@0', 'B@1', 'C@2']);
  });

  it('elides long edges into stubs that hold no lane', () => {
    const commits: CommitSpec[] = [
      ['M', ['P1', 'Q']],
      ['P1', ['P2']],
      ['P2', ['P3']],
      ['P3', ['Q']],
      ['Q', []],
    ];
    const { layout } = layoutOf(commits, { elideAfter: 2 });
    const { nodes, edges } = summarizeLayout(layout, names(commits));
    expect(nodes).toEqual(['M@0', 'P1@0', 'P2@0', 'P3@0', 'Q@0']);
    expect(edges).toContain('M→Q 0→0 via 0 elided');
    // The arrival stub is indexed at Q's row.
    expect(layout.edgesInWindow(4, 4, [])).toContain(1);
  });

  it('marks edges to parents outside the loaded history as missing', () => {
    const commits: CommitSpec[] = [
      ['B', ['A']],
      ['A', ['shallow-parent']],
    ];
    const { topo } = buildTopology(commits);
    const layout = new GraphLayout(topo, { elideAfter: Infinity, paletteSize: 10 });
    layout.run();
    const missing = summarizeLayout(layout, names(commits)).edges.filter((edge) => edge.includes('missing'));
    expect(missing).toEqual(['A→? 0→0 via 0 missing']);
  });

  it('gives neighboring lanes different colors', () => {
    const commits: CommitSpec[] = [
      ['X', ['R']],
      ['Y', ['R']],
      ['Z', ['R']],
      ['R', []],
    ];
    const { layout } = layoutOf(commits);
    const colors = [layout.nodeColor[0], layout.nodeColor[1], layout.nodeColor[2]];
    expect(colors[0]).not.toBe(colors[1]);
    expect(colors[1]).not.toBe(colors[2]);
  });
});

/** Checks the structural guarantees the renderer relies on. */
function checkInvariants(layout: GraphLayout, elideAfter: number, trunkRows: Set<number>): void {
  const topo = layout.topology;
  const e = layout.edges;
  expect(layout.rowsDone).toBe(topo.rowCount);
  // Occupancy of travel lanes on interior rows: lane → target.
  const occupancy = new Map<number, Map<number, number>>();
  for (let id = 0; id < e.count; id++) {
    const flags = e.flags[id]!;
    expect(flags & EDGE_OPEN).toBe(0);
    const targetRow = topo.rowOfId(e.target[id]!);
    if (flags & EDGE_MISSING) {
      expect(targetRow).toBe(-1);
      continue;
    }
    expect(e.toRow[id]).toBe(targetRow);
    expect(e.toLane[id]).toBe(layout.nodeLane[targetRow]);
    expect(e.fromLane[id]).toBe(layout.nodeLane[e.fromRow[id]!]);
    if (flags & EDGE_ELIDED) {
      expect(targetRow - e.fromRow[id]!).toBeGreaterThan(elideAfter);
      continue;
    }
    if (Number.isFinite(elideAfter) && !trunkRows.has(e.fromRow[id]!)) {
      expect(targetRow - e.fromRow[id]!).toBeLessThanOrEqual(elideAfter);
    }
    for (let row = e.fromRow[id]! + 1; row < targetRow; row++) {
      // A passing edge never runs through a node.
      expect(layout.nodeLane[row]).not.toBe(e.travel[id]);
      let lanes = occupancy.get(row);
      if (!lanes) occupancy.set(row, (lanes = new Map()));
      const other = lanes.get(e.travel[id]!);
      // Edges may share a lane only when they lead to the same commit.
      if (other !== undefined) expect(other).toBe(e.target[id]);
      lanes.set(e.travel[id]!, e.target[id]!);
    }
  }
  for (const row of trunkRows) expect(layout.nodeLane[row]).toBe(0);
}

function trunkRowsOf(topo: GraphTopology, tipId: number): Set<number> {
  const rows = new Set<number>();
  let row = topo.rowOfId(tipId);
  while (row >= 0) {
    rows.add(row);
    row = topo.parentCount(row) > 0 ? topo.rowOfId(topo.parentId(row, 0)) : -1;
  }
  return rows;
}

function snapshot(layout: GraphLayout) {
  const e = layout.edges;
  return {
    lanes: Array.from(layout.nodeLane.subarray(0, layout.rowsDone)),
    colors: Array.from(layout.nodeColor.subarray(0, layout.rowsDone)),
    edges: Array.from({ length: e.count }, (_, i) => [
      e.fromRow[i],
      e.toRow[i],
      e.fromLane[i],
      e.travel[i],
      e.toLane[i],
      e.color[i],
      e.flags[i],
      e.target[i],
    ]),
  };
}

describe('GraphLayout — properties on random histories', () => {
  for (const elideAfter of [Infinity, 25]) {
    for (const seed of [1, 7, 42, 1337, 9001]) {
      it(`invariants hold (seed ${seed}, elideAfter ${elideAfter})`, () => {
        const { commits, trunkTip } = randomHistory(seed, 600);
        const { topo, ids } = buildTopology(commits);
        const trunkTipId = ids.get(trunkTip)!;
        const layout = new GraphLayout(topo, { elideAfter, paletteSize: 10, trunkTipId });
        layout.run();
        checkInvariants(layout, elideAfter, trunkRowsOf(topo, trunkTipId));
      });

      it(`streaming equals one-shot (seed ${seed}, elideAfter ${elideAfter})`, () => {
        const { commits, trunkTip } = randomHistory(seed, 600);
        const whole = buildTopology(commits);
        const reference = new GraphLayout(whole.topo, {
          elideAfter,
          paletteSize: 10,
          trunkTipId: whole.ids.get(trunkTip),
        });
        reference.run();

        // Feed the same rows in random-sized batches, laying out whatever is ready in between.
        const streamed = buildTopology([], false);
        const random = rng(seed * 31);
        const idOf = (name: string) => {
          let id = streamed.ids.get(name);
          if (id === undefined) {
            id = streamed.topo.addOidHex(whole.topo.oidHexOfId(whole.ids.get(name)!));
            streamed.ids.set(name, id);
          }
          return id;
        };
        // IDs must match the reference: assign them in the same first-seen order.
        for (const [name, parents] of commits) {
          idOf(name);
          parents.forEach(idOf);
        }
        const layout = new GraphLayout(streamed.topo, {
          elideAfter,
          paletteSize: 10,
          trunkTipId: streamed.ids.get(trunkTip),
        });
        let i = 0;
        while (i < commits.length) {
          const batch = 1 + Math.floor(random() * 80);
          for (const [name, parents] of commits.slice(i, i + batch)) {
            streamed.topo.appendRow(idOf(name), parents.map(idOf));
          }
          i += batch;
          layout.run(Math.floor(random() * 120));
        }
        streamed.topo.complete = true;
        layout.run();
        expect(snapshot(layout)).toEqual(snapshot(reference));
      });
    }
  }

  it('window queries return exactly the edges a brute-force scan finds', () => {
    const { commits, trunkTip } = randomHistory(99, 3 * CHECKPOINT_INTERVAL + 37);
    for (const elideAfter of [Infinity, 30]) {
      const { topo, ids } = buildTopology(commits);
      const layout = new GraphLayout(topo, { elideAfter, paletteSize: 10, trunkTipId: ids.get(trunkTip) });
      layout.run();
      const e = layout.edges;
      const random = rng(5);
      for (let q = 0; q < 300; q++) {
        const a = Math.floor(random() * topo.rowCount);
        const b = Math.min(topo.rowCount - 1, a + Math.floor(random() * 60));
        const expected: number[] = [];
        for (let id = 0; id < e.count; id++) {
          const from = e.fromRow[id]!;
          const to = e.toRow[id]!;
          if (e.flags[id]! & EDGE_ELIDED) {
            if ((from >= a && from <= b) || (to >= a && to <= b)) expected.push(id);
          } else if (from <= b && (to === -1 || to >= a)) expected.push(id);
        }
        const actual = layout.edgesInWindow(a, b, []);
        expect(new Set(actual).size).toBe(actual.length);
        expect([...actual].sort((x, y) => x - y)).toEqual(expected);
      }
    }
  });

  it('lays out 100k commits quickly', () => {
    const { commits, trunkTip } = randomHistory(2024, 100_000);
    const { topo, ids } = buildTopology(commits);
    const layout = new GraphLayout(topo, { elideAfter: 400, paletteSize: 10, trunkTipId: ids.get(trunkTip) });
    const start = performance.now();
    layout.run();
    const elapsed = performance.now() - start;
    expect(layout.rowsDone).toBe(100_000);
    // Generous bound for CI machines; the perf suite tracks the real budget.
    expect(elapsed).toBeLessThan(1500);
  });
});
