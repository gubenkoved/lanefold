import type { GraphTopology } from '../../shared/graph/topology';

/**
 * Colors for lines of history that have one of their own, for a layout's `rowColor`: the color
 * of a tip (commit hex → lane color index) carries down its first parents, as far as they go.
 * The answer for a row depends on the rows above it: ask for rows in order, once each (a layout
 * does), with a new function per layout.
 */
export function lineColors(
  topology: GraphTopology,
  tips: ReadonlyMap<string, number>,
): (row: number) => number | undefined {
  // Tips are recognised by the first four bytes of their object ID first (no hex per row).
  const seeds = new Set<number>();
  for (const sha of tips.keys()) seeds.add(parseInt(sha.slice(0, 8), 16) >>> 0);
  /** Commit IDs a line continues to (the first parent of its last commit so far) → its color. */
  const expected = new Map<number, number>();
  return (row) => {
    const id = topology.rowId(row);
    let color = expected.get(id);
    if (color !== undefined) expected.delete(id);
    else if (seeds.has(topology.seedOfId(id))) color = tips.get(topology.oidHexOfId(id));
    if (color === undefined) return undefined;
    if (topology.parentCount(row) > 0) {
      const parent = topology.parentId(row, 0);
      // Two lines meeting (forks of one history): the one that got there first goes on.
      if (!expected.has(parent)) expected.set(parent, color);
    }
    return color;
  };
}
