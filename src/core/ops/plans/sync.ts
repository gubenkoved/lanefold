/*
 * Plans for fetch, pull and push, of branches and tags.
 */

import type { RefInfo } from '../../../shared/models';
import { isObjectId } from '../../../shared/oid';
import type { Operation } from '../../../shared/operations';
import { revisions, validateRefName } from '../../git/args';
import { remoteNames } from '../../git/queries';
import { branchesTracking, readConfiguredRemotes, remoteBranchFor } from '../../repo/remotes';
import type { Repository } from '../../repo/repository';
import type { PlanBuilder, PlanContext } from '../planner';
import { count, dirtyCount, findRef, plural, predictConflicts, short } from './common';
import { commitsOnlyOn, listOf } from './remotes';

/** The remote and remote branch name of a remote-tracking ref ("origin/feature/x"). */
function splitRemoteRef(ref: RefInfo): { remote: string; branch: string } | undefined {
  if (ref.kind !== 'remote' || !ref.remote || !ref.short.startsWith(`${ref.remote}/`)) return undefined;
  return { remote: ref.remote, branch: ref.short.slice(ref.remote.length + 1) };
}

export async function planFetch(ctx: PlanContext, op: Extract<Operation, { kind: 'fetch' }>, b: PlanBuilder) {
  const remotes = await remoteNames(ctx.repo);
  if (remotes.length === 0) {
    b.block('This repository has no remotes to fetch from.', { final: true });
    b.needsRemote = true;
  }
  if (op.remote !== undefined && !remotes.includes(op.remote))
    b.block(`There is no remote named ${op.remote}.`, { final: true });
  const args = ['fetch'];
  const flags: [string, string][] = [];
  if (op.prune) {
    args.push('--prune');
    flags.push(['--prune', 'forget remote branches that were deleted on the remote']);
  }
  const target = op.remote ?? (remotes.length === 1 ? remotes[0]! : undefined);
  if (target) args.push(target);
  else {
    args.push('--all');
    flags.push(['--all', 'every remote']);
  }
  b.command(
    args,
    `Download new commits, branches and tags from ${target ?? 'all remotes'}. Your own branches and files do not change.`,
    flags,
  );
  return `Fetch ${target ?? 'all remotes'}`;
}

export async function planPull(ctx: PlanContext, op: Extract<Operation, { kind: 'pull' }>, b: PlanBuilder) {
  const name = ctx.head.branch;
  const title = `Pull ${name ?? 'HEAD'}`;
  const branch = name ? findRef(ctx, name, 'branch') : undefined;
  if (!name || !branch) {
    b.block('Check out a branch to pull into.', { final: true });
    return title;
  }
  if (!branch.upstream) {
    b.block(`${name} has no upstream branch yet. Push it first (that sets one up).`, { final: true });
    return title;
  }
  const upstream = findRef(ctx, branch.upstream, 'remote');
  const remote = upstream && splitRemoteRef(upstream);
  if (!upstream || !remote || branch.gone) {
    b.block(`${branch.upstream} no longer exists on the remote.`, { final: true });
    return title;
  }
  const head = ctx.head.sha!;
  const incoming = await count(ctx.repo, revisions(upstream.target, `^${head}`));
  const outgoing = await count(ctx.repo, revisions(head, `^${upstream.target}`));
  const args = ['pull'];
  const flags: [string, string][] = [];
  const dirty = dirtyCount(ctx.workingTree) > 0;
  switch (op.mode) {
    case 'ff-only':
      args.push('--ff-only', '--no-rebase');
      flags.push(['--ff-only', 'only move forward; stop if your branch has commits the remote lacks']);
      if (outgoing > 0 && incoming > 0)
        b.block(
          `${name} and ${upstream.short} have diverged (${outgoing} local, ${incoming} incoming): choose rebase or merge.`,
        );
      else if (outgoing > 0)
        b.notice(
          'info',
          `${name} has ${plural(outgoing, 'commit')} of its own: if new commits come in, it cannot simply move forward and git stops (then choose rebase or merge).`,
        );
      break;
    case 'rebase': {
      args.push('--rebase', dirty ? '--autostash' : '--no-autostash');
      flags.push(['--rebase', 'replay your local commits on top of the incoming ones (no merge commit)']);
      if (dirty) flags.push(['--autostash', 'set uncommitted changes aside and restore them afterwards']);
      const yours = `your ${plural(outgoing, 'local commit')} ${outgoing === 1 ? 'is' : 'are'}`;
      const hashes = outgoing === 1 ? 'gets a new hash' : 'get new hashes';
      // Only commits that arrive make the local ones move: as of the last fetch, none might.
      if (outgoing > 0 && incoming > 0) {
        b.risk('Rewrites commits');
        b.notice(
          'info',
          `Y${yours.slice(1)} replayed on top of the incoming ones and ${hashes}. Undo puts ${name} back.`,
        );
      } else if (outgoing > 0) {
        b.notice(
          'info',
          `If new commits come in, ${yours} replayed on top of them and ${hashes}. Undo puts ${name} back.`,
        );
      }
      break;
    }
    case 'merge':
      args.push('--no-rebase', '--no-edit');
      flags.push(
        ['--no-rebase', 'merge the incoming commits (a merge commit when both sides have new commits)'],
        ['--no-edit', 'use the default merge message'],
      );
      break;
  }
  args.push(remote.remote, remote.branch);
  b.command(args, `Fetch ${upstream.short} and bring its new commits into ${name}.`, flags);
  b.notice(
    'info',
    incoming > 0
      ? `As of the last fetch, ${upstream.short} has ${plural(incoming, 'commit')} ${name} lacks; pull fetches first, so there may be more.`
      : `As of the last fetch, ${name} is up to date with ${upstream.short}; pull checks for anything newer.`,
  );
  if (dirty && op.mode !== 'rebase') {
    b.notice(
      'info',
      'You have uncommitted changes: git stops before touching files that both sides changed.',
    );
  }
  if (op.mode !== 'ff-only' && incoming > 0 && outgoing > 0) {
    const prediction = await predictConflicts(ctx.repo, head, upstream.target);
    if (prediction?.predicted) b.conflicts = prediction;
  }
  b.changes.push({
    ref: `refs/heads/${name}`,
    from: head,
    toNew: incoming > 0 ? 'the incoming commits' : 'any new commits',
  });
  return title;
}

/** How many commits of `tip` no entry of `ref`'s reflog contains (what --force-if-includes checks). */
async function notInReflog(repo: Repository, ref: string, tip: string): Promise<number> {
  const reflog = await repo.git(['reflog', 'show', '--format=%H', ...revisions(ref)], {
    readOnly: true,
    background: true,
    okExitCodes: [0, 128],
  });
  const seen = [...new Set(reflog.stdout.split('\n').filter(isObjectId))];
  const result = await repo.git(['rev-list', '--count', '--stdin'], {
    readOnly: true,
    background: true,
    stdin: [tip, ...seen.map((sha) => `^${sha}`)].join('\n') + '\n',
  });
  return Number(result.stdout.trim()) || 0;
}

export async function planPush(ctx: PlanContext, op: Extract<Operation, { kind: 'push' }>, b: PlanBuilder) {
  const name = op.branch ?? ctx.head.branch;
  const title = `Push ${name ?? 'HEAD'}`;
  const branch = name ? findRef(ctx, name, 'branch') : undefined;
  if (!name || !branch) {
    b.block(name ? `There is no branch named ${name}.` : 'Check out a branch to push.', { final: true });
    return title;
  }
  const remotes = await remoteNames(ctx.repo);
  if (remotes.length === 0) {
    b.block('This repository has no remote to push to. Add one first.', { final: true });
    b.needsRemote = true;
    return title;
  }
  const upstreamRef = branch.upstream ? findRef(ctx, branch.upstream, 'remote') : undefined;
  const upstream = upstreamRef && splitRemoteRef(upstreamRef);
  const remote = op.remote ?? upstream?.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]!);
  if (!remotes.includes(remote)) {
    b.block(`There is no remote named ${remote}.`, { final: true });
    return title;
  }
  // Pushing to the upstream (when it is on this remote), else to a same-named branch.
  const target = upstream && upstream.remote === remote ? upstream.branch : name;
  const remoteRef =
    upstream && upstream.remote === remote ? upstreamRef : findRef(ctx, `${remote}/${target}`, 'remote');
  const tip = branch.target;
  const outgoing = remoteRef
    ? await count(ctx.repo, revisions(tip, `^${remoteRef.target}`))
    : await count(ctx.repo, ['--not', '--remotes', '--not', ...revisions(tip)]);
  const incoming = remoteRef ? await count(ctx.repo, revisions(remoteRef.target, `^${tip}`)) : 0;
  const setUpstream = op.setUpstream ?? !branch.upstream;

  const args = ['push'];
  const flags: [string, string][] = [];
  if (setUpstream) {
    args.push('--set-upstream');
    flags.push(['--set-upstream', `remember ${remote}/${target} as ${name}’s upstream (for pull and push)`]);
  }
  if (op.force) {
    // The lease: replace the remote branch only if it is still what this plan showed. (With an
    // explicit value, git's --force-if-includes does nothing: the plan checks that instead.)
    args.push(`--force-with-lease=refs/heads/${target}:${remoteRef?.target ?? ''}`);
    flags.push([
      '--force-with-lease',
      remoteRef
        ? `replace ${remote}/${target}, but only if it is still at ${short(remoteRef.target)} (as shown here)`
        : `create ${remote}/${target}, but only if it does not exist yet`,
    ]);
  }
  if (op.tags) {
    args.push('--follow-tags');
    flags.push(['--follow-tags', 'also push annotated tags on the pushed commits']);
  }
  args.push(remote, target === name ? name : `${name}:${target}`);
  b.command(
    args,
    remoteRef
      ? `Send ${plural(outgoing, 'commit')} of ${name} to ${remote}/${target}.`
      : `Publish ${name} as ${remote}/${target}${outgoing > 0 ? ` (${plural(outgoing, 'new commit')})` : ''}.`,
    flags,
  );

  if (incoming > 0 && !op.force) {
    if (outgoing === 0)
      b.block(
        `${remote}/${target} is ahead of ${name}: nothing to push. Pull to get its ${plural(incoming, 'commit')}.`,
      );
    else
      b.block(
        `${remote}/${target} has ${plural(incoming, 'commit')} that ${name} lacks, so the push would be rejected. Pull first — or, if you rewrote ${name} on purpose, force push (with lease).`,
      );
  } else if (outgoing === 0 && remoteRef && !op.force && !op.tags) {
    b.block(`${remote}/${target} already has everything in ${name}.`);
  }
  if (op.force && incoming > 0) {
    b.risk('Removes commits from the remote');
    b.notice(
      'danger',
      `${plural(incoming, 'commit')} on ${remote}/${target} will be removed from the remote. Anyone who built on ${incoming === 1 ? 'it' : 'them'} will have to recover; git refuses if the remote changed since your last fetch.`,
    );
    // Commits a fetch brought in that this branch never had: replacing them unseen is how
    // someone else's work gets lost.
    const unseen = remoteRef ? await notInReflog(ctx.repo, `refs/heads/${name}`, remoteRef.target) : 0;
    if (unseen > 0)
      b.notice(
        'danger',
        `${unseen === incoming ? (unseen === 1 ? 'It' : 'They') : `${unseen} of them`} never ${unseen === 1 ? 'was' : 'were'} in your ${name}: ${unseen === 1 ? 'it' : 'they'} arrived with a fetch. Look at ${unseen === 1 ? 'it' : 'them'} in the graph before replacing ${unseen === 1 ? 'it' : 'them'}.`,
      );
    if (PROTECTED.test(target))
      b.notice('warning', `${target} looks like a shared branch: force pushing it affects everyone.`);
  } else if (op.force) {
    b.notice('info', 'Nothing on the remote would be lost: this is a plain push with a safety check.');
  }
  b.notice('info', 'A push changes the remote, which Undo cannot take back.');
  b.changes.push({
    ref: `refs/remotes/${remote}/${target}`,
    from: remoteRef?.target,
    to: tip,
  });
  return op.force ? `Force push ${name}` : title;
}

const PROTECTED = /^(?:main|master|trunk|develop|release\/.+)$/;

/** The remote a tag operation talks to: the one asked for, else origin, else the only one. */
async function tagRemote(
  ctx: PlanContext,
  asked: string | undefined,
  b: PlanBuilder,
): Promise<string | undefined> {
  const remotes = await remoteNames(ctx.repo);
  if (remotes.length === 0) {
    b.block('This repository has no remote.', { final: true });
    b.needsRemote = true;
    return undefined;
  }
  const remote =
    asked ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined);
  if (!remote) {
    b.block(`Choose a remote: ${remotes.join(', ')}.`, { final: true });
    return undefined;
  }
  if (!remotes.includes(remote)) {
    b.block(`There is no remote named ${remote}.`, { final: true });
    return undefined;
  }
  return remote;
}

export async function planPushTag(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'pushTag' }>,
  b: PlanBuilder,
) {
  const title = op.name ? `Push tag ${op.name}` : 'Push all tags';
  if (op.name !== undefined) {
    if (validateRefName(op.name) || !ctx.state.refs[`refs/tags/${op.name}`]) {
      b.block(`There is no tag named ${op.name}.`);
      return title;
    }
  }
  const remote = await tagRemote(ctx, op.remote, b);
  if (!remote) return title;
  if (op.name !== undefined) {
    b.command(['push', remote, `refs/tags/${op.name}`], `Publish the tag ${op.name} on ${remote}.`);
  } else {
    b.command(['push', remote, '--tags'], `Publish every local tag on ${remote}.`, [
      ['--tags', 'all tags under refs/tags'],
    ]);
  }
  b.notice('info', 'A tag that already exists on the remote is not replaced. Undo cannot take back a push.');
  return op.name ? `Push tag ${op.name} to ${remote}` : `Push all tags to ${remote}`;
}

export async function planDeleteRemoteTag(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'deleteRemoteTag' }>,
  b: PlanBuilder,
) {
  const title = `Delete tag ${op.name} from the remote`;
  if (validateRefName(op.name)) {
    b.block(`${op.name} is not a valid tag name.`);
    return title;
  }
  const remote = await tagRemote(ctx, op.remote, b);
  if (!remote) return title;
  b.command(
    ['push', remote, '--delete', `refs/tags/${op.name}`],
    `Delete the tag ${op.name} from ${remote}.`,
    [['--delete', 'remove the ref from the remote']],
  );
  b.risk('Deletes it from the remote');
  b.notice(
    'danger',
    `Everyone who fetches from ${remote} loses the tag; Undo cannot bring it back there. Your local tag stays.`,
  );
  return `Delete tag ${op.name} from ${remote}`;
}

/** A branch on a remote, and the remote branch here that stands for it. */
export interface RemoteBranchTarget {
  readonly remote: string;
  /** Its full name on the remote (“refs/heads/feature”). */
  readonly ref: string;
  /** Its name on the remote (“feature”). */
  readonly branch: string;
  /** The remote branch here (“origin/feature”). */
  readonly tracking: RefInfo;
}

/**
 * The branch on a remote that the remote branch `name` (“origin/feature”) stands for, or
 * undefined after blocking the plan: the remote's fetch settings tell (see remoteBranchFor).
 * Without `b`, nothing is blocked: whether there is one is the question.
 */
export async function remoteBranchTarget(
  ctx: PlanContext,
  name: string,
  b?: PlanBuilder,
): Promise<RemoteBranchTarget | undefined> {
  const tracking = findRef(ctx, name, 'remote');
  if (!tracking) {
    b?.block(`There is no remote branch named ${name}.`, { final: true });
    return undefined;
  }
  const remotes = await readConfiguredRemotes(ctx.repo);
  const found = remoteBranchFor(tracking.name, remotes);
  if (!found) {
    b?.block(
      remotes.some((remote) => name.startsWith(`${remote.name}/`))
        ? `Lanefold cannot tell which branch of the remote ${name} stands for: the remote’s fetch settings do not name it. Delete it in a terminal.`
        : `${name} belongs to no remote of this repository any more: there is nowhere to delete it from.`,
      { final: true },
    );
    return undefined;
  }
  if (!found.ref.startsWith('refs/heads/')) {
    b?.block(`${name} stands for ${found.ref} on ${found.remote}, which is not a branch.`, { final: true });
    return undefined;
  }
  // A name configured by hand may start with "-": git would read it as an option.
  if (found.remote.startsWith('-')) {
    b?.block(`git would read the remote name ${found.remote} as an option: delete it in a terminal.`, {
      final: true,
    });
    return undefined;
  }
  return { ...found, branch: found.ref.slice('refs/heads/'.length), tracking };
}

/**
 * Plans `git push --delete` of a branch on its remote, leased to the commit it was at when last
 * fetched: someone's commits pushed since are never deleted unseen. Git deletes the remote
 * branch here as it pushes. `risk`: what that means, for the sheet's badge; `doneFirst`: what the
 * steps planned before it did, should it fail (see PlanRecord.doneFirst).
 */
export function deleteOnRemote(
  b: PlanBuilder,
  target: RemoteBranchTarget,
  { risk = 'Deletes it from the remote', doneFirst }: { risk?: string; doneFirst?: string } = {},
): void {
  const { remote, ref, branch, tracking } = target;
  if (doneFirst) b.doneFirst[b.commands.length] = doneFirst;
  b.command(
    ['push', `--force-with-lease=${ref}:${tracking.target}`, remote, '--delete', ref],
    `Delete the branch ${branch} from ${remote} (and ${tracking.short} here).`,
    [
      [
        '--force-with-lease',
        `only if it is still at ${short(tracking.target)}, as last fetched: git refuses if someone pushed to it since`,
      ],
      ['--delete', 'remove the branch from the remote'],
    ],
  );
  b.risk(risk);
  b.changes.push({ ref: tracking.name, from: tracking.target });
}

/**
 * What deleting a branch from its remote means: for everyone, for commits only it has
 * (`orphaned`, 0 when the plan says so itself), for the remote's default branch, and for local
 * branches tracking it (but `deleted`, going too). `renamedTo`: a rename, which pushed it there
 * under that name first.
 */
export async function remoteDeleteNotices(
  ctx: PlanContext,
  b: PlanBuilder,
  target: RemoteBranchTarget,
  orphaned: number,
  deleted?: string,
  renamedTo?: string,
): Promise<void> {
  const { remote, branch, tracking } = target;
  const them = orphaned === 1 ? 'it' : 'them';
  if (orphaned > 0) {
    b.risk('Leaves commits behind');
    b.orphaned = orphaned;
  }
  b.notice(
    'danger',
    (renamedTo
      ? `Everyone who fetches from ${remote} loses ${branch} and gets ${renamedTo} instead; Undo renames the branch back here only, not on ${remote}.`
      : `Everyone who fetches from ${remote} loses ${branch}; Undo cannot bring it back there.`) +
      (orphaned > 0
        ? ` ${plural(orphaned, 'commit')} ${orphaned === 1 ? 'is' : 'are'} only on it: no branch keeps ${them} after that. To keep ${them}, create a branch at ${tracking.short} first.`
        : ''),
  );
  // The remote's default branch, as last fetched (git refuses to delete a bare repository's own).
  const defaultBranch = await ctx.repo.git(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
    readOnly: true,
    background: true,
    label: 'Default branch',
    okExitCodes: [0, 1, 128],
  });
  if (defaultBranch.stdout.trim() === tracking.name)
    b.notice(
      'warning',
      `${branch} is ${remote}’s default branch: the remote will most likely refuse to delete it` +
        (renamedTo ? `, leaving ${remote} with both ${branch} and ${renamedTo}.` : '.'),
    );
  else if (PROTECTED.test(branch))
    b.notice(
      'warning',
      `${branch} looks like a shared branch: ${renamedTo ? 'renaming' : 'deleting'} it affects everyone who uses ${remote}.`,
    );
  const tracked = (await branchesTracking(ctx.repo, remote))
    .filter((local) => local.upstream === tracking.short && local.branch !== deleted)
    .map((local) => local.branch);
  if (tracked.length > 0) {
    const one = tracked.length === 1;
    b.notice(
      'info',
      `${listOf(tracked, 3)} ${one ? 'tracks' : 'track'} it: afterwards, ${one ? 'its' : 'their'} upstream shows as gone, and a push publishes ${one ? 'it' : 'them'} again.`,
    );
  }
}

export async function planDeleteRemoteBranch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'deleteRemoteBranch' }>,
  b: PlanBuilder,
) {
  const target = await remoteBranchTarget(ctx, op.name, b);
  if (!target) return `Delete ${op.name}`;
  deleteOnRemote(b, target);
  await remoteDeleteNotices(ctx, b, target, await commitsOnlyOn(ctx, [target.tracking.name]));
  return `Delete branch ${target.branch} from ${target.remote}`;
}
