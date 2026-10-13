/** Parsing of raw commit objects (as printed by `git cat-file --batch`). */

export interface Ident {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly time: number;
  /** Timezone offset as written by git, e.g. "+0200". */
  readonly tz: string;
}

export interface RawCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Ident;
  readonly committer: Ident;
  /** Declared message encoding when not UTF-8. */
  readonly encoding?: string;
  /** True when the commit carries a GPG/SSH/X.509 signature. */
  readonly signed: boolean;
  /** The full message (subject, blank line, body). */
  readonly message: string;
}

const UNKNOWN_IDENT: Ident = { name: '', email: '', time: 0, tz: '+0000' };

export function parseIdent(value: string): Ident {
  const match = /^(.*?) ?<([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!match) return { ...UNKNOWN_IDENT, name: value };
  return { name: match[1]!, email: match[2]!, time: Number(match[3]), tz: match[4]! };
}

/** Decodes bytes in the commit's declared encoding (git stores the raw bytes). */
function decode(bytes: Uint8Array, encoding: string | undefined): string {
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // Unknown encoding: fall back to UTF-8 with replacement characters.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Parses a raw commit. Header continuation lines (multi-line `gpgsig`, `mergetag`) start with a
 * space and are skipped; the message starts after the first empty line.
 */
export function parseCommit(raw: Uint8Array): RawCommit {
  // Find the end of the header block (first "\n\n").
  let headerEnd = -1;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 10 && raw[i + 1] === 10) {
      headerEnd = i;
      break;
    }
  }
  const headerBytes = headerEnd < 0 ? raw : raw.subarray(0, headerEnd);
  const messageBytes = headerEnd < 0 ? new Uint8Array(0) : raw.subarray(headerEnd + 2);

  // Headers are ASCII keywords; values may be in the declared encoding, so decode after scanning.
  const headerText = new TextDecoder('latin1').decode(headerBytes);
  let encoding: string | undefined;
  for (const line of headerText.split('\n')) {
    if (line.startsWith('encoding ')) encoding = line.slice(9).trim();
  }
  const header = decode(headerBytes, encoding);

  let tree = '';
  const parents: string[] = [];
  let author = UNKNOWN_IDENT;
  let committer = UNKNOWN_IDENT;
  let signed = false;
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    switch (key) {
      case 'tree':
        tree = value;
        break;
      case 'parent':
        parents.push(value);
        break;
      case 'author':
        author = parseIdent(value);
        break;
      case 'committer':
        committer = parseIdent(value);
        break;
      case 'gpgsig':
      case 'gpgsig-sha256':
        signed = true;
        break;
    }
  }
  return { tree, parents, author, committer, encoding, signed, message: decode(messageBytes, encoding) };
}

/** The first line of a commit message. */
export function subjectOf(message: string): string {
  const newline = message.indexOf('\n');
  return (newline < 0 ? message : message.slice(0, newline)).trim();
}

/** The message without its subject line and the blank line after it. */
export function bodyOf(message: string): string {
  const newline = message.indexOf('\n');
  return newline < 0
    ? ''
    : message
        .slice(newline + 1)
        .replace(/^\n+/, '')
        .trimEnd();
}
