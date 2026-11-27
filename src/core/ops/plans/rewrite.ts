/*
 * Plans for editing history: an arranged history edit (interactive rebase with the planned todo),
 * and amending a commit with the staged changes.
 */

import { isObjectId } from '../../../shared/oid';
import type { Operation } from '../../../shared/operations';
import {
  firstRewritten,
  groupMessage,
  groupRewrite,
  layoutTodo,
  normalizeRewrite,
  renderTodo,
  validateRewrite,
} from '../../../shared/rewrite';
import { revisions } from '../../git/args';
import { MAX_REWRITE_COMMITS, readRange, readRewriteRange, simulateAmendInto } from '../../rebase/rewrite';
import type { PlanBuilder, PlanContext } from '../planner';
import {
  commitName,
  commitTitle,
  count,
  describeDirty,
  dirtyCount,
  findRef,
  isAncestor,
  parentsOf,
  plural,
  resolveCommit,
  revLabel,
  short,
  warnIfPublished,
} from './common';

/**
 * Puts the staged changes into a commit of the current branch: HEAD is simply amended; an
 * older commit (after the branch's last merge) gets them from a “fixup!” commit that
 * `git rebase --autosquash` folds in, replaying the commits after it.
 */
export async function planAmendInto(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'amendInto' }>,
  b: PlanBuilder,
) {
  const name = ctx.head.branch ?? 'HEAD';
  const head = ctx.head.sha;
  const commit = await resolveCommit(ctx.repo, op.commit);
  const title = `Amend ${commit ? await commitTitle(ctx.repo, commit) : op.commit} with the staged changes`;
  if (!head) {
    b.block('There is no commit to amend yet.');
    return title;
  }
  if (!commit) {
    b.block(`${op.commit} is not a commit.`);
    return title;
  }
  const tree = ctx.workingTree;
  if (tree.conflicted > 0) {
    b.block('Resolve the conflicts first.');
    return title;
  }
  if (tree.staged === 0) {
    b.block(`Stage what belongs in ${short(commit)} first: only staged changes go into it.`);
    return title;
  }
  const keepUnstaged = tree.unstaged > 0 ? 'Changes that are not staged stay out of it, as they are.' : '';

  if (commit === head) {
    b.command(
      ['commit', '--amend', '--no-edit'],
      `Put the staged changes into ${short(commit)}, keeping its message.`,
      [
        ['--amend', 'replace the last commit instead of adding one'],
        ['--no-edit', 'keep its message'],
      ],
    );
    b.changes.push({
      ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
      from: head,
      toNew: 'the amended commit',
    });
    const [parent] = await parentsOf(ctx.repo, head);
    await warnIfPublished(ctx, b, head, parent);
    b.notice('info', `Undo brings the changes back as staged. ${keepUnstaged}`.trim());
    return title;
  }

  if (!(await isAncestor(ctx.repo, commit, head))) {
    b.block(`${short(commit)} is not in the history of ${name}.`);
    return title;
  }
  if (!ctx.repo.runner.features.fixupWithMessage) {
    b.block('Amending an earlier commit needs git 2.32 or newer.');
    return title;
  }
  const [parent] = await parentsOf(ctx.repo, commit);
  const range = await readRewriteRange(ctx.repo, parent ?? null);
  if (!range || range.tooMany) {
    b.block(`${short(commit)} is too far back (more than ${MAX_REWRITE_COMMITS.toLocaleString()} commits).`);
    return title;
  }
  if (range.merges > 0) {
    b.block(
      `${name} has ${plural(range.merges, 'merge commit')} after ${short(commit)}: replaying the history would flatten ${range.merges === 1 ? 'it' : 'them'}. Amend a commit after the last merge.`,
    );
    return title;
  }
  const later = range.commits.length - 1;

  b.command(
    ['commit', '-m', `fixup! ${commit}`],
    `Commit the staged changes as a “fixup!” commit naming ${short(commit)}.`,
    [['-m', 'its message: “fixup!” and the commit to fold it into']],
  );
  const args = ['rebase', '-i', '--autosquash', '--no-rebase-merges', '--no-update-refs'];
  const flags: [string, string][] = [
    [
      '-i --autosquash',
      `move the “fixup!” commit right after ${short(commit)} and fold it in; Lanefold accepts the todo git writes, so no editor opens`,
    ],
    ['--no-rebase-merges', 'replay a straight line of commits'],
    ['--no-update-refs', 'leave other branches where they are'],
  ];
  if (tree.unstaged > 0) {
    args.push('--autostash');
    flags.push(['--autostash', 'set the unstaged changes aside meanwhile and bring them back afterwards']);
  } else args.push('--no-autostash');
  if (parent) args.push(parent);
  else {
    args.push('--root');
    flags.push(['--root', 'from the very first commit']);
  }
  b.command(
    args,
    later === 0
      ? `Fold it into ${short(commit)}.`
      : `Fold it into ${short(commit)} and replay the ${plural(later, 'commit')} after it on top.`,
    flags,
  );
  // Git keeps the todo it wrote: no editor is asked for it (one set in the environment included).
  b.env = { GIT_SEQUENCE_EDITOR: ':' };
  b.risk('Rewrites commits');
  b.changes.push({
    ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
    from: head,
    toNew: plural(range.commits.length, 'rewritten commit'),
  });
  b.notice(
    'info',
    `${short(commit)}${later > 0 ? ` and the ${plural(later, 'commit')} after it get new hashes` : ' gets a new hash'}; messages, authors and dates stay. Undo puts ${name} back and the changes back as staged. ${keepUnstaged}`.trim(),
  );
  await warnIfPublished(ctx, b, head, parent);

  const simulation = await simulateAmendInto(ctx.repo, range, commit).catch(() => undefined);
  const conflict = simulation?.steps.find((step) => step.status === 'conflict');
  if (conflict) {
    b.conflicts = { predicted: true, files: [...(conflict.files ?? [])] };
    b.notice(
      'warning',
      conflict.sha === commit
        ? `The staged changes do not apply cleanly to ${short(commit)}: git stops there so you can resolve the conflict.`
        : `Replaying ${short(conflict.sha)} on top conflicts with the staged changes: git stops there so you can resolve it.`,
    );
  }
  return title;
}

export async function planRewrite(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'rewrite' }>,
  b: PlanBuilder,
) {
  const name = ctx.head.branch ?? 'HEAD';
  // A rebase: the arranged commits are replayed onto another commit.
  const onto = op.onto === undefined ? undefined : await resolveCommit(ctx.repo, op.onto);
  const label =
    op.onto === undefined
      ? ''
      : isObjectId(op.onto) && onto
        ? await commitName(ctx, onto, ctx.head.branch)
        : revLabel(op.onto);
  const title = op.onto === undefined ? `Edit history of ${name}` : `Rebase ${name} onto ${label}`;
  const head = ctx.head.sha;
  if (!head) {
    b.block('There is no history to edit yet.');
    return title;
  }
  if (op.onto !== undefined && !onto) {
    b.block(`${label} is not a commit.`);
    return title;
  }
  if (!ctx.canRewrite) {
    b.block('History editing is not available here (Lanefold’s rebase helper is missing).');
    return title;
  }
  if (!ctx.repo.runner.features.fixupWithMessage) {
    b.block('History editing needs git 2.32 or newer.');
    return title;
  }
  let base: string | null = null;
  // A rebase starts where the branch and its target part: the range says where.
  if (op.onto === undefined && op.base !== null) {
    const resolved = await resolveCommit(ctx.repo, op.base);
    if (!resolved) {
      b.block(`${op.base} is not a commit.`);
      return title;
    }
    if (!(await isAncestor(ctx.repo, resolved, head))) {
      b.block(`${short(resolved)} is not in the history of ${name}.`);
      return title;
    }
    base = resolved;
  }
  const range = await readRange(ctx.repo, base, op.onto);
  if (!range) {
    b.block('There is no history to edit yet.');
    return title;
  }
  const target = range.onto;
  if (op.onto !== undefined) {
    if (!target) {
      b.block(`${name} already contains ${label}: there is nothing to rebase.`);
      return title;
    }
    base = range.base;
    b.pinned.push({ rev: op.onto, sha: target.sha });
    b.action = 'Rebase';
  }
  if (range.tooMany) {
    b.block(
      target
        ? `That is ${range.tooMany.toLocaleString()} commits to arrange (at most ${MAX_REWRITE_COMMITS.toLocaleString()}). Rebase without arranging them instead.`
        : `That is ${range.tooMany.toLocaleString()} commits; start from a more recent commit (at most ${MAX_REWRITE_COMMITS.toLocaleString()}).`,
    );
    return title;
  }
  if (range.merges > 0) {
    b.block(
      target
        ? `The commits of ${name} that ${label} lacks include ${plural(range.merges, 'merge commit')}; arranging them would flatten the merges. Rebase without arranging them instead.`
        : `The commits after ${base ? short(base) : 'the root'} include ${plural(range.merges, 'merge commit')}; editing them here would flatten the merges. Start after the last merge.`,
    );
    return title;
  }
  const original = range.commits.map((commit) => commit.sha);
  const given = new Set(op.entries.map((entry) => entry.sha));
  if (op.entries.length !== original.length || original.some((sha) => !given.has(sha))) {
    b.block(`${name} changed since this edit was arranged. Start the edit again.`);
    return title;
  }
  const problem = validateRewrite(op.entries, { fromRoot: base === null });
  if (problem) b.block(problem);

  const messages = new Map(range.commits.map((commit) => [commit.sha, commit.message]));
  const messageOf = (sha: string) => messages.get(sha);
  const entries = normalizeRewrite(op.entries, messageOf);
  // Replayed onto another commit, every commit changes: as they are is a plan too (a plain rebase).
  const from = firstRewritten(entries, range);
  if (from === entries.length) b.block('Nothing changes yet: reorder commits or choose an action.');
  const groups = groupRewrite(entries);
  const keep = from > 0 ? original[from - 1]! : base;
  const rewrittenRevs = keep ? [head, `^${keep}`] : [head];
  const rewritten = await count(ctx.repo, revisions(...rewrittenRevs));
  const rewrittenSet = new Set(original.slice(from));

  // --- the commands -------------------------------------------------------------------
  const features = ctx.repo.runner.features;
  const carriers = groups.filter((group) => group.newMessage);
  if (carriers.length > 0) {
    b.command(
      ['commit-tree', '<tree>', '-p', '<commit>', '-F', '-'],
      `Store ${carriers.length === 1 ? 'the new message' : `each of the ${carriers.length} new messages`} in an empty commit; the rebase folds ${carriers.length === 1 ? 'it' : 'them'} in with “fixup -C”, so git never opens an editor.`,
      [['-F -', 'read the message from standard input']],
    );
  }
  const args = ['-i', '--no-autosquash', '--no-rebase-merges', '--empty=keep'];
  const flags: [string, string][] = [
    ['-i', 'interactive: follow the todo below instead of replaying the commits as they are'],
    ['--no-autosquash', 'ignore “fixup!” subjects: the todo is exactly what you arranged'],
    ['--no-rebase-merges', 'replay a straight line of commits'],
    [
      '--empty=keep',
      'keep a commit whose changes are already there (as an empty commit) instead of stopping',
    ],
  ];
  const otherBranches = ctx.refs.refs.filter(
    (ref) => ref.kind === 'branch' && !ref.isHead && rewrittenSet.has(ref.target),
  );
  const updateRefs = !!op.updateRefs && features.rebaseUpdateRefs;
  if (features.rebaseUpdateRefs) {
    args.push(updateRefs ? '--update-refs' : '--no-update-refs');
    flags.push(
      updateRefs
        ? ['--update-refs', 'move other branches that point into this history along with their commits']
        : ['--no-update-refs', 'leave other branches where they are'],
    );
  }
  const dirty = dirtyCount(ctx.workingTree) > 0;
  if (dirty) {
    args.push('--autostash');
    flags.push([
      '--autostash',
      'set your uncommitted changes aside during the edit and restore them afterwards',
    ]);
  } else {
    args.push('--no-autostash');
  }
  if (target) {
    args.push('--reapply-cherry-picks', '--onto', op.onto!);
    flags.push(
      [
        '--reapply-cherry-picks',
        'take the commits exactly as arranged: git leaves none out on its own for being there already',
      ],
      [
        '--onto',
        `replay onto ${label}${base ? ` the commits after ${short(base)}, where ${name} left its history` : ''}`,
      ],
    );
  }
  if (base) args.push('--end-of-options', base);
  else {
    args.push('--root');
    flags.push(['--root', target ? 'every commit of the branch' : 'edit from the very first commit']);
  }
  const splits = groups.filter((group) => group.head.action === 'split').map((group) => group.head.sha);
  const outcome = `${plural(original.length, 'commit')} become ${plural(groups.length, 'commit')}${splits.length > 0 ? ', plus the parts split off' : ''}`;
  b.command(
    ['rebase', ...args.filter((arg) => arg !== '--end-of-options')],
    target
      ? groups.length === 0
        ? `Move ${name} to ${label}: none of its ${plural(original.length, 'commit')} is kept.`
        : `Replay ${name} on top of ${label}, following the todo: ${outcome}.`
      : `Rewrite ${name} from ${short(original[from]) || 'its first change'} on, following the todo: ${outcome}.`,
    flags,
  );

  // --- what to know first ----------------------------------------------------------------
  b.risk('Rewrites history');
  if (rewritten > 0) {
    // The commits before the first change stay as they are, one result each.
    const results = groups.length - from;
    b.notice(
      'info',
      results === 0
        ? target
          ? `${name} moves to ${label}: ${rewritten === 1 ? 'its commit leaves' : `its ${rewritten} commits leave`} the branch. Undo puts ${name} back.`
          : `${name} ${keep ? `goes back to ${short(keep)}` : 'is left with no commits'}: ${rewritten === 1 ? 'the commit after it leaves' : `the ${rewritten} commits after it leave`} the branch. Undo puts ${name} back.`
        : `${plural(rewritten, 'commit')} ${rewritten === 1 ? 'becomes' : 'become'} ${plural(results, 'new commit')}${target ? ` on top of ${label}` : ''}${splits.length > 0 ? ', plus the parts split off' : ''}; authors and author dates are kept. Undo puts ${name} back.`,
    );
    const notPushed = await count(ctx.repo, ['--not', '--remotes', '--not', ...revisions(...rewrittenRevs)]);
    const published = rewritten - notPushed;
    if (published > 0) {
      const branch = ctx.head.branch ? findRef(ctx, ctx.head.branch, 'branch') : undefined;
      b.notice(
        'warning',
        `${published === rewritten ? (published === 1 ? 'It is' : 'They are') : `${published} of them are`} already pushed${branch?.upstream ? ` (${branch.upstream})` : ''}. Publishing the result needs a force push, which affects anyone who built on them.`,
      );
    }
  }
  const edits = groups.filter((group) => group.head.action === 'edit').length;
  if (edits > 0) {
    b.notice(
      'info',
      `Git stops at ${edits === 1 ? 'the commit' : `${edits} commits`} marked “edit” so you can change ${edits === 1 ? 'it' : 'them'}; continue from the banner when done.`,
    );
  }
  if (splits.length > 0) {
    b.notice(
      'info',
      `Stops at ${splits.length === 1 ? short(splits[0]) : `each of ${splits.map(short).join(', ')}`} with ${splits.length === 1 ? 'its' : 'the'} changes uncommitted so you can commit them in parts; Continue from the banner commits what is left with the original message and author.`,
    );
  }
  if (dirty) {
    b.notice(
      'info',
      `Your uncommitted changes (${describeDirty(ctx.workingTree)}) are set aside during the edit and restored afterwards.`,
    );
  }
  const updated = updateRefs ? otherBranches.map((ref) => ref.short) : [];
  const stranded = [
    ...(updateRefs ? [] : otherBranches),
    ...ctx.refs.refs.filter((ref) => ref.kind === 'tag' && rewrittenSet.has(ref.target)),
  ].map((ref) => ref.short);
  if (stranded.length > 0) {
    b.notice(
      'info',
      `${stranded.join(', ')} ${stranded.length === 1 ? 'points' : 'point'} at commits being rewritten and will keep pointing at the old ones.`,
    );
  }

  const placeholder = (group: (typeof groups)[number]) => {
    const subject = groupMessage(group, messageOf).split('\n', 1)[0] ?? '';
    return `<message: “${subject.length > 48 ? `${subject.slice(0, 47)}…` : subject}”>`;
  };
  const layout = layoutTodo(entries, placeholder, original);
  const branchesAt = new Map<string, string[]>();
  if (updateRefs) {
    for (const ref of otherBranches) {
      const list = branchesAt.get(ref.target) ?? [];
      list.push(ref.name);
      branchesAt.set(ref.target, list);
    }
  }
  b.rewritePreview = {
    todo: renderTodo(layout, (sha) => branchesAt.get(sha) ?? []),
    before: original.length,
    after: groups.length,
    rewritten,
    strandedRefs: stranded,
    updatedRefs: updated,
    splits: splits.length || undefined,
  };
  b.rewrite = { range, entries, args };
  b.changes.push({
    ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
    from: head,
    ...(target && groups.length === 0
      ? { to: target.sha }
      : {
          toNew:
            splits.length > 0
              ? `${groups.length} or more ${target ? 'rebased' : 'rewritten'} commits`
              : plural(groups.length, target ? 'rebased commit' : 'rewritten commit'),
        }),
  });
  for (const ref of updateRefs ? otherBranches : []) {
    b.changes.push({ ref: ref.name, from: ref.target, toNew: 'its rewritten commit' });
  }
  return title;
}
