import { describe, expect, it } from 'vitest';
import { TopologyParser, type ParsedChunk } from '../../src/core/log/topologyParser';
import { GraphTopology } from '../../src/shared/graph/topology';
import { fakeOid, randomHistory, rng } from './graph-helpers';

function revListOutput(commits: readonly (readonly [string, readonly string[]])[]): string {
  return commits.map(([name, parents]) => [name, ...parents].map(fakeOid).join(' ')).join('\n') + '\n';
}

function parseAll(
  text: string,
  splits: (length: number) => number[],
): { topo: GraphTopology; chunks: ParsedChunk[] } {
  const chunks: ParsedChunk[] = [];
  const parser = new TopologyParser({
    oidBytes: 20,
    onChunk: (chunk) => chunks.push(chunk),
    firstChunkRows: 7,
  });
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  for (const size of splits(bytes.length)) {
    parser.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  parser.push(bytes.subarray(offset));
  parser.end();
  const topo = new GraphTopology(20);
  for (const chunk of chunks) topo.appendChunk({ ...chunk, logId: 1 });
  topo.complete = true;
  return { topo, chunks };
}

describe('TopologyParser', () => {
  const { commits } = randomHistory(3, 400);
  const text = revListOutput(commits);

  it('reconstructs the graph regardless of how the stream is split', () => {
    const random = rng(11);
    const whole = parseAll(text, () => []);
    const jagged = parseAll(text, (length) => {
      const sizes: number[] = [];
      let total = 0;
      while (total < length) {
        const size = 1 + Math.floor(random() * 97);
        sizes.push(size);
        total += size;
      }
      return sizes;
    });
    for (const { topo } of [whole, jagged]) {
      expect(topo.rowCount).toBe(commits.length);
      commits.forEach(([name, parents], row) => {
        expect(topo.oidHex(row)).toBe(fakeOid(name));
        expect(topo.parentCount(row)).toBe(parents.length);
        parents.forEach((parent, k) => expect(topo.oidHexOfId(topo.parentId(row, k))).toBe(fakeOid(parent)));
      });
    }
  });

  it('sends a small first chunk, then growing ones', () => {
    const { chunks } = parseAll(text, () => []);
    expect(chunks[0]!.rowIds.length).toBe(7);
    expect(chunks[1]!.rowIds.length).toBeGreaterThan(7);
    expect(chunks.reduce((sum, chunk) => sum + chunk.rowIds.length, 0)).toBe(commits.length);
  });

  it('handles CRLF, blank lines and a missing trailing newline', () => {
    const a = fakeOid('a');
    const b = fakeOid('b');
    const { topo } = parseAll(`${a} ${b}\r\n\n${b}`, () => []);
    expect(topo.rowCount).toBe(2);
    expect(topo.oidHex(1)).toBe(b);
    expect(topo.parentRow(0, 0)).toBe(1);
  });

  it('parses 1M-row histories fast', () => {
    const lines: string[] = [];
    const big = 200_000;
    for (let i = 0; i < big; i++) {
      const sha = (i + 1).toString(16).padStart(40, '0');
      const parent = (i + 2).toString(16).padStart(40, '0');
      lines.push(i === big - 1 ? sha : `${sha} ${parent}`);
    }
    const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
    const parse = () => {
      let rows = 0;
      const parser = new TopologyParser({ oidBytes: 20, onChunk: (chunk) => (rows += chunk.rowIds.length) });
      const start = performance.now();
      for (let offset = 0; offset < bytes.length; offset += 65536)
        parser.push(bytes.subarray(offset, offset + 65536));
      parser.end();
      return { rows, elapsed: performance.now() - start };
    };
    // The fastest of three runs: a busy machine slows one run, a slow parser slows them all.
    const runs = [parse(), parse(), parse()];
    for (const run of runs) expect(run.rows).toBe(big);
    // 200k rows; the 1M budget (≤ 2 s) scales linearly from this.
    expect(Math.min(...runs.map((run) => run.elapsed))).toBeLessThan(800);
  });
});
