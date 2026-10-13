import type { TopologyChunk } from '../../shared/graph/topology';
import { OidTable } from './oidTable';

/** A chunk of a merged log: every row also names its stream (`repos`). */
export type MergedChunk = Omit<TopologyChunk, 'logId'> & { readonly repos: Uint16Array };

export interface MergedParserOptions {
  /** 20 for SHA-1 repositories, 32 for SHA-256. */
  readonly oidBytes: number;
  /** How many rev-list streams are merged (rows are tagged with the index of theirs). */
  readonly sources: number;
  readonly onChunk: (chunk: MergedChunk) => void;
  /** Rows in the first chunk (small, so the first screen paints immediately). */
  readonly firstChunkRows?: number;
  /** Upper bound for later chunks (they grow up to this). */
  readonly maxChunkRows?: number;
}

const NEWLINE = 10;
const SPACE = 32;

class IntBuffer {
  data = new Int32Array(4096);
  length = 0;
  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }
  take(): Int32Array {
    const out = this.data.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

/** Parsed rows of one stream waiting for their turn, oldest first. */
class RowQueue {
  times = new Float64Array(256);
  ids = new Int32Array(256);
  /** Parents of row i: `parents[starts[i] .. starts[i + 1])`. */
  starts = new Int32Array(257);
  parents = new Int32Array(512);
  first = 0;
  count = 0;
  leftover: Uint8Array | undefined;
  /** The stream has ended (finished or failed); what is queued still gets merged. */
  ended = false;

  get size(): number {
    return this.count - this.first;
  }

  get headId(): number {
    return this.ids[this.first]!;
  }

  get headTime(): number {
    return this.times[this.first]!;
  }

  push(time: number, id: number, parents: readonly number[]): void {
    if (this.count + 2 > this.starts.length) {
      const capacity = this.ids.length * 2;
      const times = new Float64Array(capacity);
      times.set(this.times);
      this.times = times;
      const ids = new Int32Array(capacity);
      ids.set(this.ids);
      this.ids = ids;
      const starts = new Int32Array(capacity + 1);
      starts.set(this.starts);
      this.starts = starts;
    }
    const start = this.starts[this.count]!;
    if (start + parents.length > this.parents.length) {
      let capacity = this.parents.length * 2;
      while (capacity < start + parents.length) capacity *= 2;
      const grown = new Int32Array(capacity);
      grown.set(this.parents);
      this.parents = grown;
    }
    for (let k = 0; k < parents.length; k++) this.parents[start + k] = parents[k]!;
    this.times[this.count] = time;
    this.ids[this.count] = id;
    this.starts[this.count + 1] = start + parents.length;
    this.count++;
  }

  /** Drops the head row (the space it used is reclaimed now and then). */
  shift(): void {
    this.first++;
    if (this.first === this.count) {
      this.first = this.count = 0;
      this.starts[0] = 0;
    } else if (this.first >= 4096 && this.first * 2 >= this.count) {
      const rows = this.count - this.first;
      const base = this.starts[this.first]!;
      this.times.copyWithin(0, this.first, this.count);
      this.ids.copyWithin(0, this.first, this.count);
      this.parents.copyWithin(0, base, this.starts[this.count]!);
      for (let i = 0; i <= rows; i++) this.starts[i] = this.starts[this.first + i]! - base;
      this.first = 0;
      this.count = rows;
    }
  }
}

/**
 * Merges several `git rev-list --timestamp --parents --date-order` streams (one per repository)
 * into one log, newest first by commit date, each stream keeping its own order. Rows stream out
 * in chunks of growing size, with commit IDs from one table shared by every stream.
 *
 * A commit can be in several streams (clones, forks): it is shown once, for the first stream
 * that gets to it, which is the first stream listed unless clocks were skewed. A commit is
 * placed only once every row read so far that has it as a parent is placed, so the graph keeps
 * children above parents across streams; only data that arrives too late to be waited for can
 * break that, and then the link to the parent already shown above is left out (a graph is drawn
 * top-down).
 */
export class MergedTopologyParser {
  private readonly table: OidTable;
  private readonly hexLength: number;
  private readonly queues: RowQueue[];
  /** Per commit ID: rows read so far that have it as a parent and are not placed (or skipped) yet. */
  private waiting = new Int32Array(1024);
  /** Per commit ID: 1 once its row is placed. */
  private placed = new Uint8Array(1024);
  private readonly lineParents: number[] = [];
  private readonly rowIds = new IntBuffer();
  private readonly rowRepos = new IntBuffer();
  private readonly parentIds = new IntBuffer();
  private readonly parentEnds = new IntBuffer();
  private chunkStartRow = 0;
  private chunkFirstId = 0;
  private rows = 0;
  private chunkLimit: number;
  private readonly maxChunkRows: number;
  private finished = false;

  constructor(private readonly options: MergedParserOptions) {
    this.table = new OidTable(options.oidBytes);
    this.hexLength = options.oidBytes * 2;
    this.queues = Array.from({ length: options.sources }, () => new RowQueue());
    this.chunkLimit = options.firstChunkRows ?? 256;
    this.maxChunkRows = options.maxChunkRows ?? 65_536;
    if (options.sources === 0) this.finish();
  }

  get rowCount(): number {
    return this.rows;
  }

  /** True once every stream ended and every row was sent. */
  get done(): boolean {
    return this.finished;
  }

  /** Output of stream `source` (split anywhere). */
  push(source: number, data: Uint8Array): void {
    const queue = this.queues[source]!;
    if (queue.ended) return;
    let buf = data;
    if (queue.leftover) {
      buf = new Uint8Array(queue.leftover.length + data.length);
      buf.set(queue.leftover);
      buf.set(data, queue.leftover.length);
      queue.leftover = undefined;
    }
    let start = 0;
    for (;;) {
      const end = buf.indexOf(NEWLINE, start);
      if (end < 0) break;
      if (end > start) this.parseLine(queue, buf, start, end);
      start = end + 1;
    }
    if (start < buf.length) queue.leftover = buf.slice(start);
    this.drain();
  }

  /** Stream `source` is over (it finished, or failed: the rows already read are kept). */
  end(source: number): void {
    const queue = this.queues[source]!;
    if (queue.ended) return;
    if (queue.leftover && queue.leftover.length > 0)
      this.parseLine(queue, queue.leftover, 0, queue.leftover.length);
    queue.leftover = undefined;
    queue.ended = true;
    this.drain();
    if (this.queues.every((q) => q.ended && q.size === 0)) this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flush(true);
  }

  /** "<timestamp> <oid> <parent>…" */
  private parseLine(queue: RowQueue, buf: Uint8Array, start: number, end: number): void {
    const hex = this.hexLength;
    // Tolerate a trailing carriage return.
    if (buf[end - 1] === 13) end--;
    let pos = start;
    let time = 0;
    while (pos < end && buf[pos]! >= 48 && buf[pos]! <= 57) time = time * 10 + (buf[pos++]! - 48);
    while (pos < end && buf[pos] === SPACE) pos++;
    if (end - pos < hex) return;
    const id = this.table.internHex(buf, pos);
    pos += hex;
    const parents = this.lineParents;
    parents.length = 0;
    while (pos < end) {
      if (buf[pos] === SPACE) {
        pos++;
        continue;
      }
      if (end - pos < hex) break;
      parents.push(this.table.internHex(buf, pos));
      pos += hex;
    }
    this.reserveIds(this.table.count);
    for (const parent of parents) this.waiting[parent]!++;
    queue.push(time, id, parents);
  }

  private reserveIds(count: number): void {
    if (count <= this.placed.length) return;
    let capacity = this.placed.length * 2;
    while (capacity < count) capacity *= 2;
    const waiting = new Int32Array(capacity);
    waiting.set(this.waiting);
    this.waiting = waiting;
    const placed = new Uint8Array(capacity);
    placed.set(this.placed);
    this.placed = placed;
  }

  /**
   * Places rows while it is known which comes next: every stream still running has a row
   * waiting. The newest head goes first (ties: the first stream), among the heads whose
   * children are all placed; if none qualifies (streams that disagree on the order), the newest.
   */
  private drain(): void {
    const queues = this.queues;
    for (;;) {
      // Commits another stream already placed are skipped (shown once). First, for every
      // stream: skipping can make other streams' heads ready.
      for (let s = 0; s < queues.length; s++) {
        const queue = queues[s]!;
        while (queue.size > 0 && this.placed[queue.headId]) this.take(s, false);
      }
      let best = -1;
      let bestTime = 0;
      let newest = -1;
      let newestTime = 0;
      for (let s = 0; s < queues.length; s++) {
        const queue = queues[s]!;
        if (queue.size === 0) {
          if (!queue.ended) return;
          continue;
        }
        const time = queue.headTime;
        if (newest < 0 || time > newestTime) {
          newest = s;
          newestTime = time;
        }
        if (this.waiting[queue.headId] === 0 && (best < 0 || time > bestTime)) {
          best = s;
          bestTime = time;
        }
      }
      const next = best >= 0 ? best : newest;
      if (next < 0) return;
      this.take(next, true);
    }
  }

  /** Takes the head row of stream `s`: places it, or skips it (a commit placed already). */
  private take(s: number, place: boolean): void {
    const queue = this.queues[s]!;
    const from = queue.starts[queue.first]!;
    const to = queue.starts[queue.first + 1]!;
    if (place) {
      this.placed[queue.headId] = 1;
      this.rowIds.push(queue.headId);
      this.rowRepos.push(s);
    }
    for (let k = from; k < to; k++) {
      const parent = queue.parents[k]!;
      this.waiting[parent]!--;
      if (place && !this.placed[parent]) this.parentIds.push(parent);
    }
    queue.shift();
    if (!place) return;
    this.parentEnds.push(this.parentIds.length);
    this.rows++;
    if (this.rowIds.length >= this.chunkLimit) this.flush();
  }

  private flush(final = false): void {
    if (this.rowIds.length === 0 && !final) return;
    if (this.rowIds.length === 0 && this.table.count === this.chunkFirstId) return;
    const ends = this.parentEnds.take();
    const parentStart = new Uint32Array(ends.length + 1);
    parentStart.set(ends, 1);
    const chunk: MergedChunk = {
      startRow: this.chunkStartRow,
      rowIds: this.rowIds.take(),
      parentStart,
      parentIds: this.parentIds.take(),
      firstNewId: this.chunkFirstId,
      newOids: this.table.slice(this.chunkFirstId, this.table.count),
      repos: Uint16Array.from(this.rowRepos.take()),
    };
    this.chunkStartRow = this.rows;
    this.chunkFirstId = this.table.count;
    this.chunkLimit = Math.min(this.maxChunkRows, this.chunkLimit * 4);
    this.options.onChunk(chunk);
  }
}
