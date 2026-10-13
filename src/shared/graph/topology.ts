/**
 * Commit graph topology as streamed from the host: rows in display order (children before
 * parents), each referring to commits by dense integer IDs.
 *
 * IDs are assigned by the host parser the first time an object ID is seen — either as a row or
 * as somebody's parent — so parent links can be expressed before the parent's own row arrives.
 * An ID that never gets a row is a parent outside the loaded history (shallow clone boundary,
 * filtered view).
 */

/** A batch of rows (plus the object IDs of newly seen commits) sent by the host. */
export interface TopologyChunk {
  readonly logId: number;
  /** Row index of the first row in this chunk. */
  readonly startRow: number;
  /** Commit ID of each row. */
  readonly rowIds: Int32Array;
  /** Parents of row `i` are `parentIds[parentStart[i] .. parentStart[i + 1])`. */
  readonly parentStart: Uint32Array;
  readonly parentIds: Int32Array;
  /** First ID assigned in this chunk; IDs `[firstNewId, firstNewId + newOids.length / oidBytes)` are new. */
  readonly firstNewId: number;
  /** Raw object IDs (oidBytes each) of the newly assigned IDs, in ID order. */
  readonly newOids: Uint8Array;
  /** Multi-repository logs: the repository of each row (an index into the log's repositories). */
  readonly repos?: Uint16Array;
}

class GrowableInt32 {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  reserve(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    let capacity = this.data.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Int32Array(capacity);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(value: number): void {
    this.reserve(1);
    this.data[this.length++] = value;
  }
}

const HEX = '0123456789abcdef';

/** Growable, append-only commit graph in row order. */
export class GraphTopology {
  /** Bytes per object ID (20 for SHA-1, 32 for SHA-256). */
  readonly oidBytes: number;
  private readonly rows = new GrowableInt32();
  private readonly parentStarts = new GrowableInt32();
  private readonly parents = new GrowableInt32();
  private idRows: Int32Array;
  private oidStore: Uint8Array;
  private ids = 0;
  /**
   * Object ID → commit ID, open addressing on the ID's first four bytes: slots hold `id + 1`
   * (0 = empty). Built lazily and extended as IDs arrive.
   */
  private oidIndex = new Int32Array(0);
  private indexedIds = 0;
  /** The repository of each row, in a multi-repository log (undefined otherwise). */
  private repos: Uint16Array | undefined;
  /** True once the host has sent every row. */
  complete = false;

  constructor(oidBytes = 20, idCapacity = 1024) {
    this.oidBytes = oidBytes;
    this.parentStarts.push(0);
    this.idRows = new Int32Array(idCapacity).fill(-1);
    this.oidStore = new Uint8Array(idCapacity * oidBytes);
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get idCount(): number {
    return this.ids;
  }

  rowId(row: number): number {
    return this.rows.data[row]!;
  }

  parentCount(row: number): number {
    return this.parentStarts.data[row + 1]! - this.parentStarts.data[row]!;
  }

  parentId(row: number, index: number): number {
    return this.parents.data[this.parentStarts.data[row]! + index]!;
  }

  /** Row of a commit ID, or -1 if that commit has no row (yet). */
  rowOfId(id: number): number {
    return id < this.ids ? this.idRows[id]! : -1;
  }

  /** Parent row, or -1 when the parent is not (yet) loaded. */
  parentRow(row: number, index: number): number {
    return this.rowOfId(this.parentId(row, index));
  }

  private ensureIds(count: number): void {
    if (count <= this.idRows.length) return;
    let capacity = this.idRows.length * 2;
    while (capacity < count) capacity *= 2;
    const rows = new Int32Array(capacity).fill(-1);
    rows.set(this.idRows.subarray(0, this.ids));
    this.idRows = rows;
    const oids = new Uint8Array(capacity * this.oidBytes);
    oids.set(this.oidStore.subarray(0, this.ids * this.oidBytes));
    this.oidStore = oids;
  }

  /** Registers object IDs for new commit IDs (must be contiguous with the existing ones). */
  addOids(firstId: number, oids: Uint8Array): void {
    const count = oids.length / this.oidBytes;
    if (firstId !== this.ids)
      throw new Error(`Non-contiguous commit IDs: expected ${this.ids}, got ${firstId}`);
    this.ensureIds(firstId + count);
    this.oidStore.set(oids, firstId * this.oidBytes);
    this.ids = firstId + count;
  }

  /** Allocates a new commit ID for an object ID given as hex (synthetic rows, tests). */
  addOidHex(hex: string): number {
    const bytes = new Uint8Array(this.oidBytes);
    for (let i = 0; i < this.oidBytes; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2) || '00', 16);
    const id = this.ids;
    this.addOids(id, bytes);
    return id;
  }

  /**
   * Appends one row. Parents may refer to IDs whose rows arrive later. `repo`: the row's
   * repository, in a multi-repository log.
   */
  appendRow(id: number, parentIds: ArrayLike<number>, repo?: number): number {
    const row = this.rows.length;
    if (id >= this.ids) throw new Error(`Unknown commit ID ${id}`);
    this.rows.push(id);
    this.parents.reserve(parentIds.length);
    for (let i = 0; i < parentIds.length; i++) this.parents.data[this.parents.length++] = parentIds[i]!;
    this.parentStarts.push(this.parents.length);
    this.idRows[id] = row;
    if (repo !== undefined) {
      this.reserveRepos(row + 1);
      this.repos![row] = repo;
    }
    return row;
  }

  /** True when rows carry their repository (a multi-repository log). */
  get hasRowRepos(): boolean {
    return this.repos !== undefined;
  }

  /** The repository of a row: an index into a multi-repository log's repositories (0 otherwise). */
  rowRepo(row: number): number {
    return this.repos ? this.repos[row]! : 0;
  }

  private reserveRepos(rows: number): void {
    if (this.repos && this.repos.length >= rows) return;
    let capacity = Math.max(1024, this.repos?.length ?? 0);
    while (capacity < rows) capacity *= 2;
    const grown = new Uint16Array(capacity);
    if (this.repos) grown.set(this.repos);
    this.repos = grown;
  }

  /** Appends a streamed chunk. */
  appendChunk(chunk: TopologyChunk): void {
    if (chunk.startRow !== this.rows.length) {
      throw new Error(`Out-of-order chunk: expected row ${this.rows.length}, got ${chunk.startRow}`);
    }
    if (chunk.newOids.length > 0) this.addOids(chunk.firstNewId, chunk.newOids);
    const count = chunk.rowIds.length;
    for (let i = 0; i < count; i++) {
      const start = chunk.parentStart[i]!;
      const end = chunk.parentStart[i + 1]!;
      this.appendRow(chunk.rowIds[i]!, chunk.parentIds.subarray(start, end));
    }
    if (chunk.repos) {
      this.reserveRepos(chunk.startRow + count);
      this.repos!.set(chunk.repos.subarray(0, count), chunk.startRow);
    }
  }

  /** An empty topology sharing this one's commit IDs (for derived views such as filters). */
  withSameIds(): GraphTopology {
    const copy = new GraphTopology(this.oidBytes, Math.max(1, this.ids));
    if (this.ids > 0) copy.addOids(0, this.oidStore.subarray(0, this.ids * this.oidBytes));
    return copy;
  }

  /** The raw object ID bytes of a commit ID (a view, do not mutate). */
  oidOfId(id: number): Uint8Array {
    return this.oidStore.subarray(id * this.oidBytes, (id + 1) * this.oidBytes);
  }

  oidHexOfId(id: number): string {
    const base = id * this.oidBytes;
    let hex = '';
    for (let i = 0; i < this.oidBytes; i++) {
      const byte = this.oidStore[base + i]!;
      hex += HEX[byte >> 4]! + HEX[byte & 15]!;
    }
    return hex;
  }

  oidHex(row: number): string {
    return this.oidHexOfId(this.rowId(row));
  }

  /** A well-distributed 32-bit seed from a commit's object ID (stable across reloads). */
  seedOfId(id: number): number {
    const base = id * this.oidBytes;
    const s = this.oidStore;
    return ((s[base]! << 24) | (s[base + 1]! << 16) | (s[base + 2]! << 8) | s[base + 3]!) >>> 0;
  }

  /** The commit ID of a full hex object ID, or -1 (constant time). */
  idOfHex(hex: string): number {
    if (hex.length !== this.oidBytes * 2) return -1;
    const seed = parseInt(hex.slice(0, 8), 16) >>> 0;
    if (Number.isNaN(seed) || this.ids === 0) return -1;
    this.updateIndex();
    const mask = this.oidIndex.length - 1;
    for (let slot = seed & mask; ; slot = (slot + 1) & mask) {
      const entry = this.oidIndex[slot]!;
      if (entry === 0) return -1;
      if (this.seedOfId(entry - 1) === seed && this.oidHexOfId(entry - 1) === hex) return entry - 1;
    }
  }

  /** The row of a full hex object ID, or -1 (constant time). */
  rowOfHex(hex: string): number {
    const id = this.idOfHex(hex.toLowerCase());
    return id < 0 ? -1 : this.rowOfId(id);
  }

  private updateIndex(): void {
    if (this.indexedIds === this.ids) return;
    // Kept at most half full: grown (and rebuilt) when IDs arrive past that.
    if (this.ids * 2 > this.oidIndex.length) {
      let capacity = Math.max(1024, this.oidIndex.length);
      while (capacity < this.ids * 2) capacity *= 2;
      this.oidIndex = new Int32Array(capacity);
      this.indexedIds = 0;
    }
    const mask = this.oidIndex.length - 1;
    for (let id = this.indexedIds; id < this.ids; id++) {
      let slot = this.seedOfId(id) & mask;
      while (this.oidIndex[slot] !== 0) slot = (slot + 1) & mask;
      this.oidIndex[slot] = id + 1;
    }
    this.indexedIds = this.ids;
  }

  /** Finds a row by full or abbreviated hex object ID (linear scan; for lookups, not hot paths). */
  findRowByHex(hex: string): number {
    const needle = hex.toLowerCase();
    for (let row = 0; row < this.rows.length; row++) {
      if (this.oidHex(row).startsWith(needle)) return row;
    }
    return -1;
  }
}
