/*
 * Plans for a visual bisect: start it and mark commits.
 */

import type { Operation } from '../../../shared/operations';
import { revisions } from '../../git/args';
import type { PlanBuilder, PlanContext } from '../planner';
import { count, dirtyCount, isAncestor, plural, resolveCommit, short } from './common';

export async function planBisectStart(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'bisectStart' }>,
  b: PlanBuilder,
) {
  const title = 'Find the commit that introduced a problem';
  b.outcome = 'Started bisecting';
  const bad = op.bad ? await resolveCommit(ctx.repo, op.bad) : undefined;
  if (!bad) {
    b.block(op.bad ? `${op.bad} is not a commit.` : 'Choose a commit that has the problem.', {
      field: 'bad',
      missing: !op.bad,
    });
    return title;
  }
  const good: string[] = [];
  for (const rev of op.good) {
    const sha = rev ? await resolveCommit(ctx.repo, rev) : undefined;
    if (!sha) {
      b.block(rev ? `${rev} is not a commit.` : 'Choose a commit that does not have the problem.', {
        field: 'good',
        missing: !rev,
      });
      return title;
    }
    if (sha === bad || !(await isAncestor(ctx.repo, sha, bad))) {
      b.block(`${short(sha)} must be older than ${short(bad)}: the good commit comes before the bad one.`, {
        field: 'good',
      });
      return title;
    }
    good.push(sha);
  }
  if (good.length === 0) {
    b.block('Choose a commit that does not have the problem.', { field: 'good', missing: true });
    return title;
  }
  if (dirtyCount(ctx.workingTree) > 0)
    b.block('Commit or stash your changes first: bisecting checks out other commits.', { final: true });
  const suspects = await count(ctx.repo, revisions(bad, ...good.map((sha) => `^${sha}`)));
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(2, suspects))));
  b.command(
    ['bisect', 'start', bad, ...good],
    `Mark ${short(bad)} bad and ${good.length === 1 ? short(good[0]) : plural(good.length, 'commit')} good, then check out the commit halfway between: ${plural(suspects, 'suspect')}, about ${plural(steps, 'test')}.`,
  );
  b.notice(
    'info',
    `Test each commit git checks out and mark it Good, Bad or Skip. Stop bisecting returns to ${ctx.head.branch ?? short(ctx.head.sha)}.`,
  );
  return title;
}

export async function planBisectMark(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'bisectMark' }>,
  b: PlanBuilder,
) {
  const commit = op.commit ? await resolveCommit(ctx.repo, op.commit) : ctx.head.sha;
  const label = commit ? short(commit) : (op.commit ?? 'HEAD');
  const title = op.verdict === 'skip' ? `Skip ${label}` : `Mark ${label} ${op.verdict}`;
  if (op.verdict !== 'good' && op.verdict !== 'bad' && op.verdict !== 'skip') {
    b.block(`Unknown bisect verdict: ${String(op.verdict)}.`);
    return title;
  }
  if (ctx.opState.kind !== 'bisect') {
    b.block('No bisect is in progress.');
    return title;
  }
  if (!commit) {
    b.block(`${op.commit ?? 'HEAD'} is not a commit.`);
    return title;
  }
  b.command(
    ['bisect', op.verdict, ...(op.commit ? [commit] : [])],
    op.verdict === 'skip'
      ? `Leave ${label} out (it cannot be tested) and check out another commit.`
      : `${label} is ${op.verdict}: narrow the search and check out the next commit to test.`,
  );
  return title;
}
