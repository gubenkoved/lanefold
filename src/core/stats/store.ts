import { OidTable } from '../log/oidTable';
import { parseRawDate, type NumstatFile } from './parse';

/**
 * Who a commit's author is to the statistics: their name, whatever its case and spacing (one
 * person, several emails), or their email when the commit has no name. Mailmap entries are
 * applied before (git's %aN and %aE).
 */
export function personKey(name: string, email: string): string {
  const key = name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return key || `<${email.trim().toLowerCase()}>`;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
  /** The person (index into {@link CommitStore.people}). */
  readonly person: number;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  const lower = code | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/** Bit flags per commit. */
const KNOWN = 1;
const MERGE = 2;

/**
 * Every commit the statistics have read in a repository. Commits never change, so they are kept
 * across reads: object IDs interned into dense numbers (no strings), the rest in typed arrays.
 */
export class CommitStore {
  private readonly oids: OidTable;
  private readonly scratch: Uint8Array;
  /** Author time (seconds since the epoch) by commit. */
  time = new Float64Array(1024);
  /** The author's UTC offset (minutes) by commit. */
  offset = new Int16Array(1024);
  /** The author's identity (index into {@link identities}) by commit. */
  identity = new Int32Array(1024);
  private flags = new Uint8Array(1024);
  readonly identities: Identity[] = [];
  private readonly identityIds = new Map<string, number>();
  /** Person keys (see {@link personKey}). */
  readonly people: string[] = [];
  private readonly personIds = new Map<string, number>();

  constructor(readonly oidBytes = 20) {
    this.oids = new OidTable(oidBytes);
    this.scratch = new Uint8Array(oidBytes);
  }

  /** Commits known (some may only be IDs, read by `git log` later). */
  get size(): number {
    return this.oids.count;
  }

  /** The number of a commit (a new one has no metadata until {@link add}); -1 for a bad hash. */
  id(sha: string): number {
    const bytes = this.oidBytes;
    if (sha.length !== bytes * 2) return -1;
    for (let i = 0; i < bytes; i++) {
      const high = hexValue(sha.charCodeAt(2 * i));
      const low = hexValue(sha.charCodeAt(2 * i + 1));
      if (high < 0 || low < 0) return -1;
      this.scratch[i] = (high << 4) | low;
    }
    const id = this.oids.intern(this.scratch);
    this.ensure(id + 1);
    return id;
  }

  sha(id: number): string {
    const store = this.oids.store;
    let text = '';
    for (let i = id * this.oidBytes, end = i + this.oidBytes; i < end; i++) text += HEX[store[i]!];
    return text;
  }

  /** Records a commit as read by `git log --date=raw` (%H, %P, %aN, %aE, %ad); its number. */
  add(sha: string, parents: string, name: string, email: string, date: string): number {
    const id = this.id(sha);
    if (id < 0) return id;
    const { time, offset } = parseRawDate(date);
    this.time[id] = time;
    this.offset[id] = Math.max(-32_768, Math.min(32_767, offset));
    this.identity[id] = this.identityOf(name, email);
    this.flags[id] = KNOWN | (parents.trim().includes(' ') ? MERGE : 0);
    return id;
  }

  known(id: number): boolean {
    return (this.flags[id]! & KNOWN) !== 0;
  }

  isMerge(id: number): boolean {
    return (this.flags[id]! & MERGE) !== 0;
  }

  /** The person who authored a commit. */
  personOf(id: number): number {
    return this.identities[this.identity[id]!]?.person ?? -1;
  }

  /** A person's index by key; -1 when no commit read so far is theirs. */
  personId(key: string): number {
    return this.personIds.get(key) ?? -1;
  }

  private identityOf(name: string, email: string): number {
    const key = `${name}\0${email}`;
    let id = this.identityIds.get(key);
    if (id === undefined) {
      const personKeyText = personKey(name, email);
      let person = this.personIds.get(personKeyText);
      if (person === undefined) {
        person = this.people.length;
        this.people.push(personKeyText);
        this.personIds.set(personKeyText, person);
      }
      id = this.identities.length;
      this.identities.push({ name: name.trim(), email: email.trim(), person });
      this.identityIds.set(key, id);
    }
    return id;
  }

  private ensure(size: number): void {
    if (size <= this.flags.length) return;
    let capacity = this.flags.length;
    while (capacity < size) capacity *= 2;
    const grow = <T extends Float64Array | Int16Array | Int32Array | Uint8Array>(
      array: T,
      make: (n: number) => T,
    ) => {
      const next = make(capacity);
      next.set(array);
      return next;
    };
    this.time = grow(this.time, (n) => new Float64Array(n));
    this.offset = grow(this.offset, (n) => new Int16Array(n));
    this.identity = grow(this.identity, (n) => new Int32Array(n));
    this.flags = grow(this.flags, (n) => new Uint8Array(n));
  }
}

/** One commit's changed lines (`--numstat`). */
export interface CommitLines {
  readonly added: number;
  readonly removed: number;
  /**
   * Four numbers per file: its path, its previous path (-1 unless renamed or copied), lines
   * added and lines removed (-1 and -1 for a binary file). Paths are indexes into
   * {@link LineStore.paths}.
   */
  readonly files: Int32Array;
}

const NO_LINES: CommitLines = { added: 0, removed: 0, files: new Int32Array(0) };

/** Changed lines per commit (by commit number), for the newest commits of the scopes looked at. */
export class LineStore {
  private readonly commits = new Map<number, CommitLines>();
  readonly paths: string[] = [];
  private readonly pathIds = new Map<string, number>();

  get size(): number {
    return this.commits.size;
  }

  get(id: number): CommitLines | undefined {
    return this.commits.get(id);
  }

  has(id: number): boolean {
    return this.commits.has(id);
  }

  set(id: number, files: readonly NumstatFile[]): void {
    if (files.length === 0) {
      this.commits.set(id, NO_LINES);
      return;
    }
    const packed = new Int32Array(files.length * 4);
    let added = 0;
    let removed = 0;
    files.forEach((file, index) => {
      const binary = file.added === undefined || file.removed === undefined;
      packed[index * 4] = this.pathId(file.path);
      packed[index * 4 + 1] = file.oldPath === undefined ? -1 : this.pathId(file.oldPath);
      packed[index * 4 + 2] = binary ? -1 : Math.min(file.added!, 0x7fffffff);
      packed[index * 4 + 3] = binary ? -1 : Math.min(file.removed!, 0x7fffffff);
      if (!binary) {
        added += file.added!;
        removed += file.removed!;
      }
    });
    this.commits.set(id, { added, removed, files: packed });
  }

  /** Once more than `limit` commits are remembered, forgets those `keep` does not want. */
  trim(limit: number, keep: (id: number) => boolean): void {
    if (this.commits.size <= limit) return;
    for (const id of [...this.commits.keys()]) if (!keep(id)) this.commits.delete(id);
  }

  private pathId(path: string): number {
    let id = this.pathIds.get(path);
    if (id === undefined) {
      id = this.paths.length;
      this.paths.push(path);
      this.pathIds.set(path, id);
    }
    return id;
  }
}
