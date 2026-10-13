import type { GraphTopology } from './topology';

/** Edge flags. */
export const EDGE_MERGE = 1; // leads to a non-first parent
export const EDGE_ELIDED = 2; // long edge drawn as two stubs; holds no lane
export const EDGE_MISSING = 4; // the parent never appears (shallow boundary, filtered view)
export const EDGE_OPEN = 8; // the parent has not been reached yet

/** Rows between checkpoints (snapshots of the edges crossing a row boundary). */
export const CHECKPOINT_SHIFT = 8;
export const CHECKPOINT_INTERVAL = 1 << CHECKPOINT_SHIFT;

/** Color index reserved for the trunk lane; branch colors are 1..paletteSize. */
export const TRUNK_COLOR = 0;

export interface LayoutOptions {
  /** Edges spanning more than this many rows become stubs (`Infinity` draws every edge in full). */
  readonly elideAfter: number;
  /** Commit ID of the trunk tip (default branch); its first-parent chain is pinned to lane 0. */
  readonly trunkTipId?: number;
  /**
   * Alternative to `trunkTipId` for streamed histories, where IDs are only known once rows
   * arrive: identifies the trunk tip row (called for rows until the trunk starts).
   */
  readonly isTrunkTip?: (row: number) => boolean;
  /** Number of branch colors (excluding the trunk color). */
  readonly paletteSize: number;
  /** Optional color seed for a lane that starts at `row` (e.g. a hash of the branch name there). */
  readonly rowSeed?: (row: number) => number | undefined;
  /**
   * The colors lanes take turns with (default: every branch color, 1..paletteSize): a view that
   * gives some lines colors of their own (`rowColor`) leaves those out.
   */
  readonly laneColors?: readonly number[];
  /**
   * A color the node of `row` takes, carried on by the lane it continues in (a repository's main
   * line in its color; a filtered view's commits in their colors in the whole history). Called
   * once per row, in row order.
   */
  readonly rowColor?: (row: number) => number | undefined;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { elideAfter: 400, paletteSize: 10 };

/** Append-only struct-of-arrays edge storage. */
export class EdgeStore {
  count = 0;
  fromRow = new Int32Array(1024);
  toRow = new Int32Array(1024);
  fromLane = new Uint16Array(1024);
  travel = new Uint16Array(1024);
  toLane = new Uint16Array(1024);
  color = new Uint8Array(1024);
  flags = new Uint8Array(1024);
  /** Commit ID of the parent this edge leads to. */
  target = new Int32Array(1024);

  private grow(): void {
    const capacity = this.fromRow.length * 2;
    const grow32 = (a: Int32Array) => {
      const b = new Int32Array(capacity);
      b.set(a);
      return b;
    };
    const grow16 = (a: Uint16Array) => {
      const b = new Uint16Array(capacity);
      b.set(a);
      return b;
    };
    const grow8 = (a: Uint8Array) => {
      const b = new Uint8Array(capacity);
      b.set(a);
      return b;
    };
    this.fromRow = grow32(this.fromRow);
    this.toRow = grow32(this.toRow);
    this.target = grow32(this.target);
    this.fromLane = grow16(this.fromLane);
    this.travel = grow16(this.travel);
    this.toLane = grow16(this.toLane);
    this.color = grow8(this.color);
    this.flags = grow8(this.flags);
  }

  add(
    fromRow: number,
    fromLane: number,
    travel: number,
    color: number,
    flags: number,
    target: number,
  ): number {
    if (this.count === this.fromRow.length) this.grow();
    const e = this.count++;
    this.fromRow[e] = fromRow;
    this.toRow[e] = -1;
    this.fromLane[e] = fromLane;
    this.travel[e] = travel;
    this.toLane[e] = travel;
    this.color[e] = color;
    this.flags[e] = flags;
    this.target[e] = target;
    return e;
  }
}

/**
 * Assigns lanes and colors to a commit graph, incrementally, in row order.
 *
 * - A commit continues the lane of the child that reached it through its first parent; other
 *   lanes expecting it converge into it.
 * - First parents continue straight down; extra parents (merges) join a lane already heading to
 *   that parent, or take the nearest free lane.
 * - Edges travel straight in their lane and bend only within the first and last row.
 * - The trunk (default branch) first-parent chain is pinned to lane 0.
 * - Edges longer than `elideAfter` rows hold no lane; they render as stubs at both ends.
 *
 * `run()` can be called repeatedly as more rows arrive; results are identical to a single pass.
 */
export class GraphLayout {
  readonly edges = new EdgeStore();
  /** Lane of each processed row's node. */
  nodeLane = new Uint16Array(1024);
  /** Color of each processed row's node. */
  nodeColor = new Uint8Array(1024);
  /** Highest lane count used in each checkpoint block (for the graph column width). */
  blockLanes = new Uint16Array(64);
  /** Open lane-held edges at each checkpoint boundary (`index * CHECKPOINT_INTERVAL`). */
  readonly checkpoints: Int32Array[] = [new Int32Array(0)];
  /** Elided edges by arrival row, in row order (`arrivalRows[i]` ↔ `arrivalEdges[i]`). */
  arrivalRows = new Int32Array(256);
  arrivalEdges = new Int32Array(256);
  arrivalCount = 0;
  /** Rows laid out so far. */
  rowsDone = 0;
  finalized = false;

  private laneExpect = new Int32Array(16).fill(-1);
  private laneColor = new Uint8Array(16);
  private laneFirstParent = new Uint8Array(16);
  private laneEdges: number[][] = Array.from({ length: 16 }, () => []);
  private lastFreedColor = new Int16Array(16).fill(-1);
  private lanes = 0;
  private readonly pendingElided = new Map<number, number[]>();
  private trunkExpect: number;
  private trunkStarted = false;
  private readonly incoming: number[] = [];
  /** The colors lanes take turns with. */
  private readonly colors: readonly number[];

  constructor(
    readonly topology: GraphTopology,
    readonly options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ) {
    this.trunkExpect = options.trunkTipId ?? -1;
    this.colors = options.laneColors?.length
      ? options.laneColors
      : Array.from({ length: options.paletteSize }, (_, index) => index + 1);
  }

  /** Number of rows that must arrive after a row before it can be laid out. */
  private get lookahead(): number {
    return Number.isFinite(this.options.elideAfter) ? this.options.elideAfter : 0;
  }

  /** Rows that can be laid out with the data available now. */
  get readyRows(): number {
    const topo = this.topology;
    return topo.complete ? topo.rowCount : Math.max(0, topo.rowCount - this.lookahead);
  }

  /** Lays out up to `maxRows` more rows; returns how many were processed. */
  run(maxRows = Infinity): number {
    const limit = this.readyRows;
    const start = this.rowsDone;
    while (this.rowsDone < limit && this.rowsDone - start < maxRows) {
      this.processRow(this.rowsDone);
      this.rowsDone++;
    }
    if (this.topology.complete && this.rowsDone === this.topology.rowCount && !this.finalized)
      this.finalize();
    return this.rowsDone - start;
  }

  /** Graph width (in lanes) needed to draw rows `[a, b]`. */
  lanesInRange(a: number, b: number): number {
    let max = 1;
    const last = Math.min(b, this.rowsDone - 1) >> CHECKPOINT_SHIFT;
    for (let block = Math.max(0, a) >> CHECKPOINT_SHIFT; block <= last; block++) {
      max = Math.max(max, this.blockLanes[block] ?? 0);
    }
    return max;
  }

  /**
   * Collects the edges that must be drawn for rows `[a, b]`: lane-held edges overlapping the
   * window, plus elided edges whose departure or arrival stub is inside it. Cost is proportional
   * to the visible rows plus the edges crossing the window — independent of history size.
   */
  edgesInWindow(a: number, b: number, out: number[]): number[] {
    out.length = 0;
    const e = this.edges;
    const block = Math.max(0, a) >> CHECKPOINT_SHIFT;
    const checkpoint = this.checkpoints[Math.min(block, this.checkpoints.length - 1)]!;
    const blockStart = Math.min(block, this.checkpoints.length - 1) << CHECKPOINT_SHIFT;
    for (let i = 0; i < checkpoint.length; i++) {
      const id = checkpoint[i]!;
      if (e.toRow[id] === -1 || e.toRow[id]! >= a) out.push(id);
    }
    // Edges are created in row order, so fromRow is non-decreasing: binary search the start.
    let lo = 0;
    let hi = e.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (e.fromRow[mid]! < blockStart) lo = mid + 1;
      else hi = mid;
    }
    for (let id = lo; id < e.count && e.fromRow[id]! <= b; id++) {
      if (e.flags[id]! & EDGE_ELIDED) {
        if (e.fromRow[id]! >= a) out.push(id);
      } else if (e.toRow[id] === -1 || e.toRow[id]! >= a) out.push(id);
    }
    // Arrival stubs of elided edges.
    lo = 0;
    hi = this.arrivalCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.arrivalRows[mid]! < a) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.arrivalCount && this.arrivalRows[i]! <= b; i++) {
      const id = this.arrivalEdges[i]!;
      if (e.fromRow[id]! < a) out.push(id);
    }
    return out;
  }

  // ---- internals -------------------------------------------------------------------------

  private ensureRows(rows: number): void {
    if (rows <= this.nodeLane.length) return;
    let capacity = this.nodeLane.length * 2;
    while (capacity < rows) capacity *= 2;
    const lanes = new Uint16Array(capacity);
    lanes.set(this.nodeLane);
    this.nodeLane = lanes;
    const colors = new Uint8Array(capacity);
    colors.set(this.nodeColor);
    this.nodeColor = colors;
  }

  private ensureLanes(count: number): void {
    if (count <= this.laneExpect.length) return;
    let capacity = this.laneExpect.length * 2;
    while (capacity < count) capacity *= 2;
    const expect = new Int32Array(capacity).fill(-1);
    expect.set(this.laneExpect);
    this.laneExpect = expect;
    const color = new Uint8Array(capacity);
    color.set(this.laneColor);
    this.laneColor = color;
    const firstParent = new Uint8Array(capacity);
    firstParent.set(this.laneFirstParent);
    this.laneFirstParent = firstParent;
    const freed = new Int16Array(capacity).fill(-1);
    freed.set(this.lastFreedColor);
    this.lastFreedColor = freed;
    while (this.laneEdges.length < capacity) this.laneEdges.push([]);
  }

  private isFree(lane: number): boolean {
    return lane >= this.lanes || this.laneExpect[lane] === -1;
  }

  private get trunkReserved(): boolean {
    const hasTrunk = this.options.trunkTipId !== undefined || this.options.isTrunkTip !== undefined;
    return hasTrunk && (!this.trunkStarted || this.trunkExpect !== -1);
  }

  private leftmostFree(): number {
    const first = this.trunkReserved ? 1 : 0;
    for (let lane = first; lane < this.lanes; lane++) if (this.laneExpect[lane] === -1) return lane;
    return Math.max(this.lanes, first);
  }

  /** Free lane closest to `near` (ties go right), never `exclude`, never the reserved trunk lane. */
  private nearestFree(near: number, exclude: number): number {
    const first = this.trunkReserved ? 1 : 0;
    for (let distance = 1; distance <= this.lanes + 1; distance++) {
      const right = near + distance;
      if (right !== exclude && right >= first && this.isFree(right)) return right;
      const left = near - distance;
      if (left >= first && left !== exclude && left < this.lanes && this.isFree(left)) return left;
    }
    return Math.max(this.lanes, first, exclude + 1);
  }

  private pickColor(seed: number, lane: number): number {
    const colors = this.colors;
    const neighbor = (l: number) =>
      l >= 0 && l < this.lanes && this.laneExpect[l] !== -1 ? this.laneColor[l]! : -1;
    const left = neighbor(lane - 1);
    const right = neighbor(lane + 1);
    const freed = lane < this.lastFreedColor.length ? this.lastFreedColor[lane]! : -1;
    const first = seed % colors.length;
    for (let tries = 0; tries < colors.length; tries++) {
      const color = colors[(first + tries) % colors.length]!;
      if (color !== left && color !== right && color !== freed) return color;
    }
    return colors[first]!;
  }

  private freeLane(lane: number): void {
    this.laneExpect[lane] = -1;
    this.laneFirstParent[lane] = 0;
    this.lastFreedColor[lane] = this.laneColor[lane]!;
    while (
      this.lanes > 0 &&
      this.laneExpect[this.lanes - 1] === -1 &&
      this.laneEdges[this.lanes - 1]!.length === 0
    ) {
      this.lanes--;
    }
  }

  private processRow(r: number): void {
    const topo = this.topology;
    const e = this.edges;
    const id = topo.rowId(r);
    this.ensureRows(r + 1);
    const lanesBefore = this.lanes;

    // 1. Lanes arriving at this commit.
    const incoming = this.incoming;
    incoming.length = 0;
    for (let lane = 0; lane < this.lanes; lane++) if (this.laneExpect[lane] === id) incoming.push(lane);

    const isTrunk =
      (this.trunkExpect !== -1 && this.trunkExpect === id) ||
      (!this.trunkStarted && this.trunkExpect === -1 && (this.options.isTrunkTip?.(r) ?? false));
    let lane = -1;
    if (isTrunk) {
      lane = 0;
      this.trunkStarted = true;
    } else {
      for (const candidate of incoming) {
        if (this.laneFirstParent[candidate]) {
          lane = candidate;
          break;
        }
      }
      if (lane < 0 && incoming.length > 0) lane = incoming[0]!;
      if (lane < 0) lane = this.leftmostFree();
    }
    this.ensureLanes(lane + 2);
    if (lane >= this.lanes) this.lanes = lane + 1;
    const continuing = incoming.includes(lane);

    // 2. Close the edges that arrive here.
    for (const arriving of incoming) {
      for (const edge of this.laneEdges[arriving]!) {
        e.toRow[edge] = r;
        e.toLane[edge] = lane;
        e.flags[edge] = e.flags[edge]! & ~EDGE_OPEN;
      }
      this.laneEdges[arriving] = [];
      if (arriving !== lane) this.freeLane(arriving);
    }
    const elided = this.pendingElided.get(id);
    if (elided) {
      for (const edge of elided) {
        e.toRow[edge] = r;
        e.toLane[edge] = lane;
        e.flags[edge] = e.flags[edge]! & ~EDGE_OPEN;
        this.pushArrival(r, edge);
      }
      this.pendingElided.delete(id);
    }

    // 3. The node.
    const forced = this.options.rowColor?.(r);
    let color: number;
    if (forced !== undefined) color = forced;
    else if (isTrunk) color = TRUNK_COLOR;
    else if (continuing) color = this.laneColor[lane]!;
    else color = this.pickColor(this.options.rowSeed?.(r) ?? topo.seedOfId(id), lane);
    this.laneColor[lane] = color;
    this.laneExpect[lane] = -1;
    this.laneFirstParent[lane] = 0;
    this.nodeLane[r] = lane;
    this.nodeColor[r] = color;

    // 4. Edges to the parents.
    const parentCount = topo.parentCount(r);
    const elideAfter = this.options.elideAfter;
    let laneUsed = false;
    for (let k = 0; k < parentCount; k++) {
      const parent = topo.parentId(r, k);
      const parentRow = topo.rowOfId(parent);
      const firstParent = k === 0;
      const kindFlag = firstParent ? 0 : EDGE_MERGE;

      // With a finite threshold, the lookahead guarantees that a parent within reach has already
      // arrived; anything else is far below (or never coming) and becomes a stub. Without a
      // threshold every edge holds a lane; edges to parents that never arrive are marked missing
      // when the history is complete (see finalize), so streamed and one-shot layouts are equal.
      let elide = false;
      let missing = false;
      if (Number.isFinite(elideAfter) && !(firstParent && isTrunk)) {
        if (parentRow >= 0) elide = parentRow - r > elideAfter;
        else {
          elide = true;
          missing = topo.complete;
        }
      }

      if (elide) {
        const edge = e.add(
          r,
          lane,
          lane,
          firstParent ? color : this.laneColorFor(parent, lane),
          kindFlag | EDGE_ELIDED | (missing ? EDGE_MISSING : EDGE_OPEN),
          parent,
        );
        if (!missing) {
          const list = this.pendingElided.get(parent);
          if (list) list.push(edge);
          else this.pendingElided.set(parent, [edge]);
        }
        continue;
      }

      let travel: number;
      if (firstParent) travel = lane;
      else {
        travel = -1;
        for (let l = 0; l < this.lanes; l++) {
          if (l !== lane && this.laneExpect[l] === parent) {
            travel = l;
            break;
          }
        }
        if (travel < 0) travel = this.nearestFree(lane, lane);
      }
      this.ensureLanes(travel + 2);
      if (travel >= this.lanes) this.lanes = travel + 1;
      if (this.laneExpect[travel] === -1) {
        this.laneColor[travel] = firstParent ? color : this.pickColor(topo.seedOfId(parent), travel);
        this.laneExpect[travel] = parent;
      }
      if (firstParent) this.laneFirstParent[travel] = 1;
      const edge = e.add(r, lane, travel, this.laneColor[travel]!, kindFlag | EDGE_OPEN, parent);
      this.laneEdges[travel]!.push(edge);
      if (travel === lane) laneUsed = true;
    }

    if (!laneUsed) this.freeLane(lane);
    if (isTrunk) {
      // The trunk continues through its first parent; it ends at a root or a missing parent.
      const next = parentCount > 0 ? topo.parentId(r, 0) : -1;
      const nextMissing = next !== -1 && topo.complete && topo.rowOfId(next) < 0;
      this.trunkExpect = next === -1 || nextMissing ? -1 : next;
    }

    // 5. Bookkeeping: graph width per block and checkpoints.
    const block = r >> CHECKPOINT_SHIFT;
    if (block >= this.blockLanes.length) {
      const grown = new Uint16Array(this.blockLanes.length * 2);
      grown.set(this.blockLanes);
      this.blockLanes = grown;
    }
    const width = Math.max(lanesBefore, this.lanes, lane + 1);
    if (width > this.blockLanes[block]!) this.blockLanes[block] = width;
    if (((r + 1) & (CHECKPOINT_INTERVAL - 1)) === 0) this.checkpoint();
  }

  /** Color an elided merge edge uses (the lane heading to that parent, if any). */
  private laneColorFor(parent: number, exclude: number): number {
    for (let l = 0; l < this.lanes; l++)
      if (l !== exclude && this.laneExpect[l] === parent) return this.laneColor[l]!;
    return this.colors[this.topology.seedOfId(parent) % this.colors.length]!;
  }

  private pushArrival(row: number, edge: number): void {
    if (this.arrivalCount === this.arrivalRows.length) {
      const rows = new Int32Array(this.arrivalRows.length * 2);
      rows.set(this.arrivalRows);
      this.arrivalRows = rows;
      const edges = new Int32Array(this.arrivalEdges.length * 2);
      edges.set(this.arrivalEdges);
      this.arrivalEdges = edges;
    }
    this.arrivalRows[this.arrivalCount] = row;
    this.arrivalEdges[this.arrivalCount++] = edge;
  }

  private checkpoint(): void {
    let size = 0;
    for (let lane = 0; lane < this.lanes; lane++) size += this.laneEdges[lane]!.length;
    const snapshot = new Int32Array(size);
    let i = 0;
    for (let lane = 0; lane < this.lanes; lane++)
      for (const edge of this.laneEdges[lane]!) snapshot[i++] = edge;
    this.checkpoints.push(snapshot);
  }

  /** Marks edges whose parents never arrived once the whole history has been laid out. */
  private finalize(): void {
    this.finalized = true;
    const e = this.edges;
    for (let lane = 0; lane < this.lanes; lane++) {
      for (const edge of this.laneEdges[lane]!) e.flags[edge] = (e.flags[edge]! & ~EDGE_OPEN) | EDGE_MISSING;
    }
    for (const edges of this.pendingElided.values()) {
      for (const edge of edges) e.flags[edge] = (e.flags[edge]! & ~EDGE_OPEN) | EDGE_MISSING;
    }
    this.pendingElided.clear();
  }
}
