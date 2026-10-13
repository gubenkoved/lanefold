/**
 * Interns object IDs given as hex digits into dense integer IDs without creating strings.
 * Open addressing over a power-of-two table; the raw bytes live in one contiguous store.
 *
 * The slot hash mixes *every* byte with a per-table random seed: object IDs are normally
 * uniform, but a repository can be crafted with many commits sharing a prefix (cheap to brute
 * force for 32 bits), which would turn a prefix-keyed table into a quadratic-time DoS.
 */
export class OidTable {
  private table: Int32Array;
  private mask: number;
  store: Uint8Array;
  count = 0;
  private readonly scratch: Uint8Array;
  private readonly seed = (Math.random() * 0xffffffff) >>> 0;

  private hash(bytes: Uint8Array, base: number): number {
    let h = this.seed ^ 0x9e3779b9;
    const n = this.oidBytes;
    for (let i = 0; i < n; i += 4) {
      const word =
        (bytes[base + i]! << 24) |
        (bytes[base + i + 1]! << 16) |
        (bytes[base + i + 2]! << 8) |
        bytes[base + i + 3]!;
      h = Math.imul(h ^ word, 0x85ebca6b);
      h ^= h >>> 13;
    }
    h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  constructor(
    readonly oidBytes: number,
    capacity = 1 << 14,
  ) {
    let size = 16;
    while (size < capacity * 2) size *= 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    this.store = new Uint8Array(capacity * oidBytes);
    this.scratch = new Uint8Array(oidBytes);
  }

  /** Hex digits of an object ID start at `buf[offset]`; returns its ID (new or existing). */
  internHex(buf: Uint8Array, offset: number): number {
    const bytes = this.oidBytes;
    const scratch = this.scratch;
    for (let i = 0; i < bytes; i++) {
      scratch[i] = (hexValue(buf[offset + 2 * i]!) << 4) | hexValue(buf[offset + 2 * i + 1]!);
    }
    return this.intern(scratch);
  }

  intern(oid: Uint8Array): number {
    const bytes = this.oidBytes;
    let slot = this.hash(oid, 0) & this.mask;
    for (;;) {
      const id = this.table[slot]!;
      if (id === -1) break;
      const base = id * bytes;
      let equal = true;
      for (let i = 0; i < bytes; i++) {
        if (this.store[base + i] !== oid[i]) {
          equal = false;
          break;
        }
      }
      if (equal) return id;
      slot = (slot + 1) & this.mask;
    }
    const id = this.count++;
    if (this.count * bytes > this.store.length) {
      const grown = new Uint8Array(this.store.length * 2);
      grown.set(this.store);
      this.store = grown;
    }
    this.store.set(oid, id * bytes);
    this.table[slot] = id;
    if (this.count * 2 > this.table.length) this.rehash();
    return id;
  }

  private rehash(): void {
    const size = this.table.length * 2;
    const table = new Int32Array(size).fill(-1);
    const mask = size - 1;
    const bytes = this.oidBytes;
    for (let id = 0; id < this.count; id++) {
      let slot = this.hash(this.store, id * bytes) & mask;
      while (table[slot] !== -1) slot = (slot + 1) & mask;
      table[slot] = id;
    }
    this.table = table;
    this.mask = mask;
  }

  /** Copy of the raw bytes for IDs `[from, to)`. */
  slice(from: number, to: number): Uint8Array {
    return this.store.slice(from * this.oidBytes, to * this.oidBytes);
  }
}

function hexValue(code: number): number {
  // '0'-'9' → 0-9, 'a'-'f' → 10-15, 'A'-'F' → 10-15
  return code <= 57 ? code - 48 : (code | 32) - 87;
}
