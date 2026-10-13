/**
 * Streaming parser for the `git log -z` output the statistics read: every commit starts with an
 * RS byte (`--format=%x1e%H%x00…`), its fields are NUL-separated, and with `--numstat` its files
 * follow ("added TAB removed TAB path" each, NUL-terminated; a rename or copy as
 * "added TAB removed TAB" then the old and the new path as fields of their own; "-" counts for
 * binary files). Merges have no numstat unless git is asked for one.
 */

const RS = 0x1e;
const NEWLINE = 10;

export interface NumstatFile {
  readonly path: string;
  /** The path before a rename or copy. */
  readonly oldPath?: string;
  /** Lines added and removed; undefined for a binary file. */
  readonly added?: number;
  readonly removed?: number;
}

export interface LogRecord {
  readonly sha: string;
  /** The format's fields after the hash. */
  readonly fields: readonly string[];
  /** The commit's files (none without `--numstat`, nor for a merge). */
  readonly files: readonly NumstatFile[];
}

interface OpenRecord {
  readonly sha: string;
  readonly fields: string[];
  readonly files: NumstatFile[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** "-" (binary) is undefined. */
function count(text: string): number | undefined {
  if (text === '-') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parses output as it streams in: whole fields are decoded at each push (a NUL never occurs
 * inside a UTF-8 sequence, so a chunk is cut after its last one), and `onRecord` gets each commit
 * once the next one starts (or at {@link end}).
 */
export class StatsLogParser {
  private readonly decoder = new TextDecoder('utf-8');
  /** Bytes after the last NUL seen (the start of a field). */
  private pending: Uint8Array[] = [];
  private record: OpenRecord | undefined;
  /** A rename's counts, waiting for its old and new path. */
  private rename: { added?: number; removed?: number; oldPath?: string } | undefined;

  /**
   * @param fieldCount The format's fields after the hash (`%P`, `%aN`… : 4 for the metadata
   *   read, 0 for `--format=%x1e%H`).
   */
  constructor(
    private readonly fieldCount: number,
    private readonly onRecord: (record: LogRecord) => void,
  ) {}

  push(chunk: Uint8Array): void {
    const last = chunk.lastIndexOf(0);
    if (last < 0) {
      this.pending.push(chunk);
      return;
    }
    const whole = chunk.subarray(0, last + 1);
    const bytes = this.pending.length > 0 ? concat([...this.pending, whole]) : whole;
    this.pending = last + 1 < chunk.length ? [chunk.subarray(last + 1)] : [];
    const fields = this.decoder.decode(bytes).split('\0');
    // The text ends with a NUL: the last element is empty.
    for (let i = 0; i < fields.length - 1; i++) this.field(fields[i]!);
  }

  /** The output ended: the last commit is complete. */
  end(): void {
    if (this.pending.length > 0) {
      const rest = this.decoder.decode(concat(this.pending));
      this.pending = [];
      if (rest) this.field(rest);
    }
    this.flush();
  }

  private flush(): void {
    const record = this.record;
    this.record = undefined;
    this.rename = undefined;
    if (record) this.onRecord(record);
  }

  private field(field: string): void {
    const record = this.record;
    // Header fields are taken by position: a name may hold any character.
    if (record && record.fields.length < this.fieldCount) {
      record.fields.push(field);
      return;
    }
    const rename = this.rename;
    if (record && rename) {
      if (rename.oldPath === undefined) rename.oldPath = field;
      else {
        record.files.push({
          path: field,
          oldPath: rename.oldPath,
          added: rename.added,
          removed: rename.removed,
        });
        this.rename = undefined;
      }
      return;
    }
    if (field.charCodeAt(0) === RS) {
      this.flush();
      this.record = { sha: field.slice(1), fields: [], files: [] };
      return;
    }
    if (!record) return;
    // The first file of a commit follows the newline that ends its header.
    const line = field.charCodeAt(0) === NEWLINE ? field.slice(1) : field;
    const tab = line.indexOf('\t');
    const tab2 = tab < 0 ? -1 : line.indexOf('\t', tab + 1);
    if (tab2 < 0) return;
    const added = count(line.slice(0, tab));
    const removed = count(line.slice(tab + 1, tab2));
    const path = line.slice(tab2 + 1);
    if (path) record.files.push({ path, added, removed });
    else this.rename = { added, removed };
  }
}

/** Parses a `--date=raw` date ("1700000000 +0530"): seconds since the epoch, offset in minutes. */
export function parseRawDate(raw: string): { time: number; offset: number } {
  const space = raw.indexOf(' ');
  const time = Number(space < 0 ? raw : raw.slice(0, space));
  const zone = /^([+-])(\d\d)(\d\d)$/.exec(space < 0 ? '' : raw.slice(space + 1));
  const offset = zone ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : 0;
  return { time: Number.isFinite(time) ? time : 0, offset };
}
