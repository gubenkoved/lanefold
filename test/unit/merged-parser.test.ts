import { describe, expect, it } from 'vitest';
import { MergedTopologyParser, type MergedChunk } from '../../src/core/log/mergedParser';
import { GraphTopology } from '../../src/shared/graph/topology';
import { fakeOid, rng } from './graph-helpers';

/** A line of `git rev-list --timestamp --parents`: commit time, commit, parents. */
type Line = readonly [time: number, name: string, parents?: readonly string[]];

function text(lines: readonly Line[]): Uint8Array {
  const out = lines.map(([time, name, parents = []]) => [time, ...[name, ...parents].map(fakeOid)].join(' '));
  return new TextEncoder().encode(out.map((line) => `${line}\n`).join(''));
}

interface Merged {
  /** "name@stream" per row, top to bottom. */
  readonly rows: string[];
  /** Parents of each row, by name. */
  readonly parents: Record<string, string[]>;
  readonly chunks: MergedChunk[];
}

function parser(sources: number, firstChunkRows = 3) {
  const chunks: MergedChunk[] = [];
  const merged = new MergedTopologyParser({
    oidBytes: 20,
    sources,
    onChunk: (chunk) => chunks.push(chunk),
    firstChunkRows,
  });
  return { merged, chunks };
}

function read(chunks: readonly MergedChunk[], names: readonly string[]): Merged {
  const byOid = new Map(names.map((name) => [fakeOid(name), name]));
  const topo = new GraphTopology(20);
  for (const chunk of chunks) topo.appendChunk({ ...chunk, logId: 1 });
  const rows: string[] = [];
  const parents: Record<string, string[]> = {};
  for (let row = 0; row < topo.rowCount; row++) {
    const name = byOid.get(topo.oidHex(row)) ?? '?';
    rows.push(`${name}@${topo.rowRepo(row)}`);
    parents[name] = Array.from({ length: topo.parentCount(row) }, (_, k) => {
      return byOid.get(topo.oidHexOfId(topo.parentId(row, k))) ?? '?';
    });
  }
  return { rows, parents, chunks: [...chunks] };
}

/**
 * Merges streams fed in random pieces, interleaved at random; each stream ends after its last
 * piece (`stop[i]`: after that many bytes instead, as if it failed there).
 */
function merge(streams: readonly (readonly Line[])[], seed = 1, stop: readonly (number | undefined)[] = []) {
  const { merged, chunks } = parser(streams.length);
  const random = rng(seed);
  const data = streams.map(text);
  const sizes = data.map((bytes, i) => Math.min(bytes.length, stop[i] ?? bytes.length));
  const offsets = streams.map(() => 0);
  streams.forEach((_, i) => sizes[i] === 0 && merged.end(i));
  for (;;) {
    const open = offsets.flatMap((offset, i) => (offset < sizes[i]! ? [i] : []));
    if (open.length === 0) break;
    const s = open[Math.floor(random() * open.length)]!;
    const end = Math.min(sizes[s]!, offsets[s]! + 1 + Math.floor(random() * 90));
    merged.push(s, data[s]!.subarray(offsets[s]!, end));
    offsets[s] = end;
    if (end === sizes[s]) merged.end(s);
  }
  expect(merged.done).toBe(true);
  const names = streams.flatMap((lines) => lines.flatMap(([, name, parents = []]) => [name, ...parents]));
  return read(chunks, names);
}

describe('MergedTopologyParser', () => {
  const a: Line[] = [
    [50, 'a3', ['a2']],
    [30, 'a2', ['a1']],
    [10, 'a1'],
  ];
  const b: Line[] = [
    [40, 'b2', ['b1']],
    [20, 'b1'],
  ];
  const c: Line[] = [[45, 'c1']];

  it('merges newest first by commit date, each row tagged with its repository', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { rows, parents } = merge([a, b, c], seed);
      expect(rows).toEqual(['a3@0', 'c1@2', 'b2@1', 'a2@0', 'b1@1', 'a1@0']);
      expect(parents).toEqual({ a3: ['a2'], c1: [], b2: ['b1'], a2: ['a1'], b1: [], a1: [] });
    }
  });

  it('keeps each repository in its own order, even when its dates are not', () => {
    // Skewed clocks: a child dated before its parent still comes first.
    const skewed: Line[] = [
      [5, 'child', ['parent']],
      [30, 'parent'],
    ];
    const { rows } = merge([skewed, b], 7);
    expect(rows).toEqual(['b2@1', 'b1@1', 'child@0', 'parent@0']);
  });

  it('gives ties to the first repository', () => {
    const { rows } = merge([[[10, 'x']], [[10, 'y']], [[10, 'z']]], 3);
    expect(rows).toEqual(['x@0', 'y@1', 'z@2']);
  });

  it('shows a commit of several repositories once, for the first of them', () => {
    // Clones of one project, each with work of its own on top.
    const shared: Line[] = [
      [20, 's2', ['s1']],
      [10, 's1'],
    ];
    const origin: Line[] = [[30, 'mine', ['s2']], ...shared];
    const fork: Line[] = [[25, 'theirs', ['s2']], ...shared];
    const third: Line[] = [
      [22, 'other', ['s1']],
      [10, 's1'],
    ];
    for (const seed of [1, 2, 3]) {
      const { rows, parents } = merge([origin, fork, third], seed);
      expect(rows).toEqual(['mine@0', 'theirs@1', 'other@2', 's2@0', 's1@0']);
      // The fork's commit links to the shared one, below it.
      expect(parents.theirs).toEqual(['s2']);
      expect(parents.other).toEqual(['s1']);
    }
  });

  it('places a shared commit only after its children in every repository', () => {
    // Same second: the first repository's s2 must still wait for the fork's child of it.
    const origin: Line[] = [
      [20, 's2', ['s1']],
      [10, 's1'],
    ];
    const fork: Line[] = [[20, 'theirs', ['s2']], ...origin];
    for (const seed of [1, 2, 3]) {
      const { rows } = merge([origin, fork], seed);
      expect(rows).toEqual(['theirs@1', 's2@0', 's1@0']);
    }
  });

  it('keeps what a failed repository read, and does not wait for an empty one', () => {
    const failing: Line[] = [
      [40, 'f2', ['f1']],
      [20, 'f1'],
    ];
    // The failing stream stops after its first line.
    const firstLine = text(failing.slice(0, 1)).length;
    const { rows, parents } = merge([a, failing, []], 5, [undefined, firstLine, 0]);
    expect(rows).toEqual(['a3@0', 'f2@1', 'a2@0', 'a1@0']);
    // Its parent never came: the edge stays (drawn as leading out of the view).
    expect(parents.f2).toEqual(['f1']);
  });

  it('streams a small first chunk, then bigger ones', () => {
    const many: Line[] = Array.from({ length: 40 }, (_, i) => [
      100 - i * 2,
      `m${i}`,
      i < 39 ? [`m${i + 1}`] : [],
    ]);
    const more: Line[] = Array.from({ length: 30 }, (_, i) => [
      99 - i * 2,
      `n${i}`,
      i < 29 ? [`n${i + 1}`] : [],
    ]);
    const { rows, chunks } = merge([many, more], 9);
    expect(rows).toHaveLength(70);
    expect(chunks[0]!.rowIds.length).toBe(3);
    expect(chunks[1]!.rowIds.length).toBe(12);
    expect(chunks.every((chunk) => chunk.repos.length === chunk.rowIds.length)).toBe(true);
    expect(rows.slice(0, 4)).toEqual(['m0@0', 'n0@1', 'm1@0', 'n1@1']);
  });

  it('waits for every running repository before placing rows', () => {
    const { merged, chunks } = parser(2, 1);
    merged.push(0, text([[50, 'a3', ['a2']]]));
    // The second repository may still have something newer.
    expect(chunks).toHaveLength(0);
    merged.push(1, text([[40, 'b2']]));
    expect(read(chunks, ['a3', 'a2', 'b2']).rows).toEqual(['a3@0']);
    merged.end(1);
    merged.end(0);
    expect(read(chunks, ['a3', 'a2', 'b2']).rows).toEqual(['a3@0', 'b2@1']);
    expect(merged.done).toBe(true);
  });

  it('leaves out the link to a parent already shown when a child comes too late', () => {
    const { merged, chunks } = parser(2, 1);
    merged.push(
      0,
      text([
        [30, 'x'],
        [1, 'old'],
      ]),
    );
    merged.end(0);
    // The second repository's first line comes first; its child of x only later.
    merged.push(1, text([[20, 'b']]));
    merged.push(1, text([[5, 'late', ['x']]]));
    merged.end(1);
    const { rows, parents } = read(chunks, ['x', 'old', 'b', 'late']);
    expect(rows).toEqual(['x@0', 'b@1', 'late@1', 'old@0']);
    expect(parents.late).toEqual([]);
  });

  it('handles CRLF and a last line without a newline', () => {
    const { merged, chunks } = parser(1);
    merged.push(0, new TextEncoder().encode(`20 ${fakeOid('p')} ${fakeOid('q')}\r\n10 ${fakeOid('q')}`));
    merged.end(0);
    expect(read(chunks, ['p', 'q'])).toMatchObject({ rows: ['p@0', 'q@0'], parents: { p: ['q'], q: [] } });
  });

  it('merges large histories quickly', () => {
    const random = rng(4);
    const streams = [0, 1, 2].map((s) => {
      const lines: Line[] = [];
      let time = 2_000_000_000;
      for (let i = 0; i < 60_000; i++) {
        time -= Math.floor(random() * 50);
        lines.push([time, `s${s}c${i}`, i < 59_999 ? [`s${s}c${i + 1}`] : []]);
      }
      return text(lines);
    });
    const started = performance.now();
    const { merged } = parser(3, 256);
    for (let s = 0; s < 3; s++) {
      for (let offset = 0; offset < streams[s]!.length; offset += 65_536)
        merged.push(s, streams[s]!.subarray(offset, offset + 65_536));
      merged.end(s);
    }
    expect(merged.rowCount).toBe(180_000);
    // About 0.6 s on a quiet machine; the budget is for runaway costs, with room for busy runners.
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
