import type { TopologyChunk } from '../../shared/graph/topology';
import { OidTable } from './oidTable';

export type ParsedChunk = Omit<TopologyChunk, 'logId'>;

export interface TopologyParserOptions {
  /** 20 for SHA-1 repositories, 32 for SHA-256. */
  readonly oidBytes: number;
  readonly onChunk: (chunk: ParsedChunk) => void;
  /** Rows in the first chunk (small, so the first screen paints immediately). */
  readonly firstChunkRows?: number;
  /** Upper bound for later chunks (they double in size up to this). */
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

/**
 * Streaming parser for `git rev-list --parents` output ("<oid> <parent> <parent>…\n" per row).
 * Works directly on bytes; emits {@link TopologyChunk}s of growing size.
 */
export class TopologyParser {
  private readonly table: OidTable;
  private readonly hexLength: number;
  private leftover: Uint8Array | undefined;
  private readonly rowIds = new IntBuffer();
  private readonly parentIds = new IntBuffer();
  private readonly parentEnds = new IntBuffer();
  private chunkStartRow = 0;
  private chunkFirstId = 0;
  private rows = 0;
  private chunkLimit: number;
  private readonly maxChunkRows: number;

  constructor(private readonly options: TopologyParserOptions) {
    this.table = new OidTable(options.oidBytes);
    this.hexLength = options.oidBytes * 2;
    this.chunkLimit = options.firstChunkRows ?? 256;
    this.maxChunkRows = options.maxChunkRows ?? 65_536;
  }

  get rowCount(): number {
    return this.rows;
  }

  push(data: Uint8Array): void {
    let buf = data;
    if (this.leftover) {
      buf = new Uint8Array(this.leftover.length + data.length);
      buf.set(this.leftover);
      buf.set(data, this.leftover.length);
      this.leftover = undefined;
    }
    let start = 0;
    for (;;) {
      const end = buf.indexOf(NEWLINE, start);
      if (end < 0) break;
      if (end > start) this.parseLine(buf, start, end);
      start = end + 1;
      if (this.rowIds.length >= this.chunkLimit) this.flush();
    }
    if (start < buf.length) this.leftover = buf.slice(start);
  }

  end(): void {
    if (this.leftover && this.leftover.length > 0) {
      this.parseLine(this.leftover, 0, this.leftover.length);
      this.leftover = undefined;
    }
    this.flush(true);
  }

  private parseLine(buf: Uint8Array, start: number, end: number): void {
    const hex = this.hexLength;
    // Tolerate a trailing carriage return.
    if (buf[end - 1] === 13) end--;
    if (end - start < hex) return;
    this.rowIds.push(this.table.internHex(buf, start));
    let pos = start + hex;
    while (pos < end) {
      if (buf[pos] === SPACE) {
        pos++;
        continue;
      }
      if (end - pos < hex) break;
      this.parentIds.push(this.table.internHex(buf, pos));
      pos += hex;
    }
    this.parentEnds.push(this.parentIds.length);
    this.rows++;
  }

  private flush(final = false): void {
    if (this.rowIds.length === 0 && !final) return;
    if (this.rowIds.length === 0 && this.table.count === this.chunkFirstId) return;
    const ends = this.parentEnds.take();
    const parentStart = new Uint32Array(ends.length + 1);
    parentStart.set(ends, 1);
    const chunk: ParsedChunk = {
      startRow: this.chunkStartRow,
      rowIds: this.rowIds.take(),
      parentStart,
      parentIds: this.parentIds.take(),
      firstNewId: this.chunkFirstId,
      newOids: this.table.slice(this.chunkFirstId, this.table.count),
    };
    this.chunkStartRow = this.rows;
    this.chunkFirstId = this.table.count;
    this.chunkLimit = Math.min(this.maxChunkRows, this.chunkLimit * 4);
    this.options.onChunk(chunk);
  }
}
