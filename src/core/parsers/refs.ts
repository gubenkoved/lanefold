import type { RefInfo } from '../../shared/models';

/**
 * `git for-each-ref` format producing one NUL-separated record per line: refname, objecttype,
 * objectname, peeled objectname, upstream, track, HEAD marker, symref, creator date.
 */
export const REFS_FORMAT = [
  '%(refname)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(symref)',
  '%(creatordate:unix)',
].join('%00');

export const REFS_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags'];

/**
 * The fields of {@link REFS_FORMAT} that need no object read: refname, objectname, upstream,
 * track, HEAD marker, symref. The rest (type, peeled object, date) depend only on the object, so
 * they can be remembered per object ID: with tens of thousands of tags, opening every object is
 * what makes reading refs slow.
 */
export const REFS_FAST_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(symref)',
].join('%00');

/** What a ref's object says about the ref (the same for every ref to that object). */
export interface RefObject {
  /** "commit", "tag" (annotated tag), "tree" or "blob". */
  readonly type: string;
  /** For an annotated tag, the object it points to. */
  readonly peeled?: string;
  /** Creation date in seconds: the commit's committer date or the tag's tagger date. */
  readonly date?: number;
}

/** Reads type, peeled object and date from an object's raw contents (as `%(creatordate)` does). */
export function parseRefObject(type: string, data: Uint8Array): RefObject {
  if (type !== 'commit' && type !== 'tag') return { type };
  // Only the header matters: it ends at the first blank line.
  const text = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 64 * 1024)));
  const header = text.slice(0, text.indexOf('\n\n') >= 0 ? text.indexOf('\n\n') : text.length);
  let peeled: string | undefined;
  let date: number | undefined;
  for (const line of header.split('\n')) {
    if (type === 'tag' && line.startsWith('object ')) peeled = line.slice('object '.length).trim();
    const person = type === 'commit' ? 'committer ' : 'tagger ';
    if (line.startsWith(person)) {
      // "<name> <email> <seconds> <zone>"
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) date = Number(match[1]);
    }
  }
  return { type, peeled, date };
}

/** Splits `for-each-ref` output (one NUL-separated record per line) into records of fields. */
export function splitRefRecords(output: string): string[][] {
  const records: string[][] = [];
  for (const line of output.split('\n')) if (line) records.push(line.split('\0'));
  return records;
}

/**
 * Turns {@link REFS_FAST_FORMAT} records into {@link REFS_FORMAT} ones with the remembered
 * objects, for {@link parseRefRecords}. Records whose object is unknown keep empty fields.
 */
export function composeRefRecords(
  fast: readonly (readonly string[])[],
  objects: ReadonlyMap<string, RefObject>,
): string[][] {
  return fast.map(([name = '', object = '', upstream = '', track = '', head = '', symref = '']) => {
    const info = objects.get(object);
    const date = info?.date === undefined ? '' : String(info.date);
    return [name, info?.type ?? '', object, info?.peeled ?? '', upstream, track, head, symref, date];
  });
}

/** Parses `%(upstream:track,nobracket)`: "", "ahead 2", "behind 1", "ahead 2, behind 1" or "gone". */
function parseTrack(track: string): Pick<RefInfo, 'ahead' | 'behind' | 'gone'> {
  if (track === 'gone') return { gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** Parses `git for-each-ref --format=<REFS_FORMAT>` output. Skips symrefs and non-commit refs. */
export function parseRefs(output: string): RefInfo[] {
  return parseRefRecords(splitRefRecords(output));
}

/** Parses {@link REFS_FORMAT} records (see {@link splitRefRecords}). */
export function parseRefRecords(records: readonly (readonly string[])[]): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const record of records) {
    const [name, type, object, peeled, upstream, track, head, symref, created] = record;
    if (!name || symref) continue; // e.g. refs/remotes/origin/HEAD
    const annotated = type === 'tag';
    const target = annotated ? peeled : object;
    if (!target || (annotated ? false : type !== 'commit')) continue;
    const date = Number(created) || undefined;
    if (name.startsWith('refs/heads/')) {
      refs.push({
        name,
        short: name.slice('refs/heads/'.length),
        kind: 'branch',
        target,
        upstream: upstream || undefined,
        ...(upstream ? parseTrack(track ?? '') : {}),
        isHead: head === '*' || undefined,
        date,
      });
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice('refs/remotes/'.length);
      refs.push({ name, short, kind: 'remote', target, remote: short.slice(0, short.indexOf('/')), date });
    } else if (name.startsWith('refs/tags/')) {
      refs.push({
        name,
        short: name.slice('refs/tags/'.length),
        kind: 'tag',
        target,
        annotated: annotated || undefined,
        date,
      });
    }
  }
  return refs;
}

/**
 * Picks the trunk (default) branch: the local branch tracking the remote's HEAD, else a local
 * `main`/`master`/`trunk`/`develop`, else the remote's default branch.
 */
export function pickTrunk(refs: readonly RefInfo[], remoteHead: string | undefined): string | undefined {
  const locals = new Map(refs.filter((r) => r.kind === 'branch').map((r) => [r.short, r]));
  if (remoteHead) {
    const branch = remoteHead.slice(remoteHead.indexOf('/') + 1);
    if (locals.has(branch)) return branch;
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) if (locals.has(name)) return name;
  if (remoteHead && refs.some((r) => r.short === remoteHead)) return remoteHead;
  return undefined;
}
