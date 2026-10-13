import type { ChangedFile, FileStatus, SubmoduleChange } from '../../shared/models';

/** The mode git gives a submodule's entry (a "gitlink": a commit of another repository). */
export const GITLINK_MODE = '160000';

/** A gitlink's commits on each side of a raw diff record (undefined when neither side is one). */
function gitlinkChange(fields: readonly string[]): SubmoduleChange | undefined {
  const [srcMode, dstMode, srcOid, dstOid] = fields;
  if (srcMode !== GITLINK_MODE && dstMode !== GITLINK_MODE) return undefined;
  // All zeros: absent, or (in the working tree) not known without looking inside the submodule.
  const known = (oid: string | undefined) => (oid && /[1-9a-f]/.test(oid) ? oid : undefined);
  return {
    from: srcMode === GITLINK_MODE ? known(srcOid) : undefined,
    to: dstMode === GITLINK_MODE ? known(dstOid) : undefined,
  };
}

/**
 * Parses `git diff-tree -r -z --raw --numstat …` (or `git diff -z --raw --numstat …`): raw
 * records (":srcmode dstmode srcsha dstsha STATUS\0path\0[newpath\0]") followed by numstat
 * records ("added\tdeleted\tpath\0" or, for renames, "added\tdeleted\t\0old\0new\0").
 */
export function parseRawNumstat(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  const raw: {
    status: FileStatus;
    score?: number;
    path: string;
    oldPath?: string;
    submodule?: SubmoduleChange;
  }[] = [];
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === '') {
      i++;
      continue;
    }
    if (token.startsWith(':')) {
      const fields = token.slice(1).split(' ');
      const statusField = fields[4] ?? 'M';
      const status = statusField[0] as FileStatus;
      const score = statusField.length > 1 ? Number(statusField.slice(1)) : undefined;
      const gitlink = gitlinkChange(fields);
      const submodule = gitlink ? { submodule: gitlink } : {};
      if (status === 'R' || status === 'C') {
        raw.push({ status, score, oldPath: tokens[i + 1], path: tokens[i + 2]!, ...submodule });
        i += 3;
      } else {
        raw.push({ status, path: tokens[i + 1]!, ...submodule });
        i += 2;
      }
      continue;
    }
    // numstat record
    const [added, deleted, path] = token.split('\t');
    const binary = added === '-' && deleted === '-';
    const entry = { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary };
    if (path === '' || path === undefined) {
      // Rename: the old and new paths follow as separate tokens.
      stats.set(tokens[i + 2]!, entry);
      i += 3;
    } else {
      stats.set(path, entry);
      i += 1;
    }
  }
  return raw.map((file) => {
    const stat = stats.get(file.path) ?? { additions: 0, deletions: 0, binary: false };
    // A submodule's counts are of git's "Subproject commit <hash>" lines: no lines of anything.
    return file.submodule ? { ...file, ...stat, additions: 0, deletions: 0 } : { ...file, ...stat };
  });
}
