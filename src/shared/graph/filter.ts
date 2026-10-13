import type { GraphTopology } from './topology';

/**
 * Builds the topology of a filtered view: only the rows where `keep[row]` is set, with every
 * kept commit's parents rewritten to its nearest kept ancestors so the graph stays connected.
 * (git rewrites parents for path-limited history, but not for `--author`/`--grep` filters.)
 *
 * Runs in one pass from the oldest row up, carrying for each row the set of nearest kept
 * commits at or below it (capped at `maxParents`, which bounds memory on wide histories).
 * Parents outside the loaded history stay as they are (drawn as dangling edges).
 */
export function filterTopology(source: GraphTopology, keep: Uint8Array, maxParents = 4): GraphTopology {
  const rows = source.rowCount;
  // Nearest kept commit IDs per row: the first in `first`, any others in `more`.
  const first = new Int32Array(rows).fill(-1);
  const more = new Map<number, number[]>();
  const scratch: number[] = [];

  const collectParents = (row: number, out: number[]) => {
    out.length = 0;
    const count = source.parentCount(row);
    for (let k = 0; k < count && out.length < maxParents; k++) {
      const parentRow = source.parentRow(row, k);
      if (parentRow < 0) {
        // Outside the loaded history: keep the edge so it renders as a stub.
        if (keep[row]) pushUnique(out, source.parentId(row, k), maxParents);
        continue;
      }
      const head = first[parentRow]!;
      if (head < 0) continue;
      pushUnique(out, head, maxParents);
      const rest = more.get(parentRow);
      if (rest) for (const id of rest) pushUnique(out, id, maxParents);
    }
  };

  for (let row = rows - 1; row >= 0; row--) {
    if (keep[row]) {
      first[row] = source.rowId(row);
      continue;
    }
    collectParents(row, scratch);
    if (scratch.length === 0) continue;
    first[row] = scratch[0]!;
    if (scratch.length > 1) more.set(row, scratch.slice(1));
  }

  const result = source.withSameIds();
  const parents: number[] = [];
  for (let row = 0; row < rows; row++) {
    if (!keep[row]) continue;
    collectParents(row, parents);
    result.appendRow(source.rowId(row), parents, source.hasRowRepos ? source.rowRepo(row) : undefined);
  }
  result.complete = source.complete;
  return result;
}

function pushUnique(list: number[], value: number, max: number): void {
  if (list.length < max && !list.includes(value)) list.push(value);
}
