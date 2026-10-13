import { describe, expect, it } from 'vitest';
import { filterTopology } from '../../src/shared/graph/filter';
import { GraphLayout } from '../../src/shared/graph/layout';
import { hueDistance, lanesClearOf, laneHues, TRUNK_HUE } from '../../src/webview/graph/hues';
import { lineColors } from '../../src/webview/graph/mainLines';
import { REPO_HUES, repoHue } from '../../src/webview/graph/repoColorSlots';
import { buildTopology, fakeOid, randomHistory, type CommitSpec } from './graph-helpers';

describe('lane hues', () => {
  it('are the trunk blue, then golden-angle hues clear of it', () => {
    const hues = laneHues(10);
    expect(hues).toHaveLength(11);
    expect(hues[0]).toBe(TRUNK_HUE);
    expect(hues[1]).toBeCloseTo(28);
    expect(hues[2]).toBeCloseTo(165.508);
    for (const hue of hues.slice(1)) expect(hueDistance(hue, TRUNK_HUE)).toBeGreaterThan(28);
  });

  it('leave out the branch colors close to repository colors', () => {
    const hues = laneHues(10);
    const avoid = [repoHue(0), repoHue(1)];
    const clear = lanesClearOf(avoid, 10);
    expect(clear.length).toBeGreaterThanOrEqual(3);
    expect(clear.length).toBeLessThan(10);
    for (const index of clear)
      for (const hue of avoid) expect(hueDistance(hues[index]!, hue)).toBeGreaterThanOrEqual(30);
    // Every hue taken: too few would be left to tell lanes apart, so all of them stay.
    const every = Array.from({ length: REPO_HUES }, (_, slot) => repoHue(slot));
    expect(lanesClearOf(every, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('repository hues go around the wheel and repeat for the second tier', () => {
    expect(repoHue(0)).toBe(15);
    expect(repoHue(1)).toBe(45);
    expect(repoHue(REPO_HUES)).toBe(repoHue(0));
  });
});

describe('layout colors', () => {
  const history = randomHistory(7, 300).commits;

  it('take turns with the lane colors given, the same as before by default', () => {
    const { topo } = buildTopology(history);
    const plain = new GraphLayout(topo, { elideAfter: 40, paletteSize: 10 });
    plain.run();
    const listed = new GraphLayout(topo, {
      elideAfter: 40,
      paletteSize: 10,
      laneColors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    listed.run();
    expect(Array.from(listed.nodeColor.subarray(0, topo.rowCount))).toEqual(
      Array.from(plain.nodeColor.subarray(0, topo.rowCount)),
    );

    const two = new GraphLayout(topo, { elideAfter: 40, paletteSize: 10, laneColors: [3, 7] });
    two.run();
    for (let row = 0; row < topo.rowCount; row++) expect([3, 7]).toContain(two.nodeColor[row]);
    for (let edge = 0; edge < two.edges.count; edge++) expect([3, 7]).toContain(two.edges.color[edge]);
  });

  it('carry a line’s own color down its first parents', () => {
    // a → b → c is a line of its own; s is a side branch merged into b.
    const commits: CommitSpec[] = [
      ['a', ['b']],
      ['b', ['c', 's']],
      ['s', ['c']],
      ['c', []],
      ['x', []],
    ];
    const { topo } = buildTopology(commits);
    const layout = new GraphLayout(topo, {
      elideAfter: Infinity,
      paletteSize: 10,
      rowColor: lineColors(topo, new Map([[fakeOid('a'), 40]])),
    });
    layout.run();
    const color = (name: string) => layout.nodeColor[commits.findIndex(([n]) => n === name)];
    expect([color('a'), color('b'), color('c')]).toEqual([40, 40, 40]);
    expect(color('s')).not.toBe(40);
    expect(color('x')).not.toBe(40);
  });

  it('give two lines that meet the color of the one that got there first', () => {
    const commits: CommitSpec[] = [
      ['p', ['base']],
      ['q', ['base']],
      ['base', []],
    ];
    const { topo } = buildTopology(commits);
    const layout = new GraphLayout(topo, {
      elideAfter: Infinity,
      paletteSize: 10,
      rowColor: lineColors(
        topo,
        new Map([
          [fakeOid('p'), 40],
          [fakeOid('q'), 41],
        ]),
      ),
    });
    layout.run();
    expect(Array.from(layout.nodeColor.subarray(0, 3))).toEqual([40, 41, 40]);
  });

  it('keep a filtered view’s commits in their colors in the whole history', () => {
    const { commits, trunkTip } = randomHistory(11, 400);
    const { topo, ids } = buildTopology(commits);
    const source = new GraphLayout(topo, { elideAfter: 60, paletteSize: 10, trunkTipId: ids.get(trunkTip) });
    source.run();
    const keep = new Uint8Array(topo.rowCount).map((_, row) => (row % 3 === 0 ? 1 : 0));
    const filtered = filterTopology(topo, keep);
    filtered.complete = true;
    // As a derived log model does: the filtered rows share the source's commit IDs.
    const layout = new GraphLayout(filtered, {
      elideAfter: 60,
      paletteSize: 10,
      rowColor: (row) => source.nodeColor[topo.rowOfId(filtered.rowId(row))],
    });
    layout.run();
    for (let row = 0; row < filtered.rowCount; row++)
      expect(layout.nodeColor[row]).toBe(source.nodeColor[topo.rowOfId(filtered.rowId(row))]);
    // Without them, the filtered graph would have repainted some.
    const repainted = new GraphLayout(filtered, { elideAfter: 60, paletteSize: 10 });
    repainted.run();
    let differ = 0;
    for (let row = 0; row < filtered.rowCount; row++)
      if (repainted.nodeColor[row] !== layout.nodeColor[row]) differ++;
    expect(differ).toBeGreaterThan(0);
  });
});
