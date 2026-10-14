import type { RefInfo } from '../../../shared/models';

/**
 * The remote of a remote branch's name (“origin/feature”): the longest of `remotes` it starts
 * with (a remote's name may hold “/”), if any.
 */
export function remoteOfName(name: string, remotes: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const remote of remotes)
    if (name.startsWith(`${remote}/`) && (owner === undefined || remote.length > owner.length))
      owner = remote;
  return owner;
}

/**
 * Local branches whose upstream is gone: deleted on its remote (a merged pull request's branch,
 * say), and pruned here. With `remote`, only those whose upstream was on it (with the remotes
 * not known, an upstream's remote is what precedes its first “/”).
 */
export function goneBranches(
  refs: readonly RefInfo[],
  remotes: readonly string[],
  remote?: string,
): RefInfo[] {
  const on = (upstream: string) =>
    remoteOfName(upstream, remotes) ?? upstream.slice(0, upstream.indexOf('/'));
  return refs.filter(
    (ref) =>
      ref.kind === 'branch' &&
      ref.gone &&
      !!ref.upstream &&
      (remote === undefined || on(ref.upstream) === remote),
  );
}
