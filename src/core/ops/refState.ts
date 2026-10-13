import type { RefChange, RefState } from '../../shared/operations';
import type { Repository } from '../repo/repository';

/** Refs an operation can change and Undo restores: local branches and tags. */
export const JOURNAL_REF_PATTERNS = ['refs/heads', 'refs/tags'];

/** Reads HEAD and the journaled refs (raw object IDs: annotated tags are not peeled). */
export async function readRefState(repo: Repository): Promise<RefState> {
  const [{ stdout }, head] = await Promise.all([
    repo.git(['for-each-ref', '--format=%(refname)%00%(objectname)', ...JOURNAL_REF_PATTERNS], {
      readOnly: true,
      background: true,
      label: 'Read refs',
    }),
    repo.head(),
  ]);
  const refs: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const [name, object] = line.split('\0');
    if (name && object) refs[name] = object;
  }
  return { branch: head.branch, head: head.sha, refs };
}

/** Refs whose value differs between two states (`from`/`to` undefined = absent). */
export function diffRefStates(before: RefState, after: RefState): RefChange[] {
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  const changes: RefChange[] = [];
  for (const ref of [...names].sort()) {
    const from = before.refs[ref];
    const to = after.refs[ref];
    if (from !== to) changes.push({ ref, from, to });
  }
  return changes;
}

/** True when HEAD points at a different branch or (detached) commit. */
export function headMoved(a: RefState, b: RefState): boolean {
  return a.branch !== b.branch || (a.branch === undefined && a.head !== b.head);
}

/** Short display name of a full ref ("refs/heads/main" → "main"). */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags|remotes)\//, '');
}
