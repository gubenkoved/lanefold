/*
 * The history editor's bars: the summary in its header, the toolbar of actions, and the
 * notices below.
 */

import { useState, type ReactNode } from 'react';
import {
  autosquash,
  autosquashCandidates,
  type RewriteProblem,
  type RewriteStep,
} from '../../../shared/rewrite';
import { Icon } from '../../components/Icon';
import { shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import {
  arrange,
  moveSelection,
  resetArrangement,
  setAction,
  setUpdateRefs,
  useRewrite,
  type RewriteSession,
} from '../../state/rewrite';
import { ACTIONS, ACTION_ORDER } from './actions';
import styles from './HistoryEditor.module.css';

/** Why the arrangement cannot be applied, the commit it is about, and ways out of it. */
export interface Problem {
  readonly message: string;
  readonly sha?: string;
  readonly kind?: RewriteProblem['kind'];
  readonly fixes: readonly {
    readonly label: string;
    readonly title?: string;
    readonly run: () => void | Promise<void>;
  }[];
}

export function ToolButton({
  icon,
  label,
  shortcut,
  disabled,
  pressed,
  className,
  onClick,
}: {
  icon: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[styles.tool, className ?? ''].join(' ')}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

/** “6 commits → 4”, and whether it can be applied: what the dry run says, or why not. */
export function Summary({
  session,
  conflict,
  problem,
  dirty,
  onShow,
}: {
  session: RewriteSession;
  conflict: RewriteStep | undefined;
  problem: Problem | undefined;
  dirty: boolean;
  /** Selects the commit a state is about. */
  onShow: (sha: string) => void;
}) {
  const before = session.range.commits.length;
  const after = session.plan?.rewrite?.after ?? before;
  // A split commit becomes one or more.
  const splits = session.plan?.rewrite?.splits ?? 0;
  let prediction: ReactNode;
  if (!dirty) prediction = null;
  else if (problem)
    prediction = (
      <State
        // A refused Apply lights it up again.
        key={session.refusals}
        nudge={session.refusals > 0}
        state="blocked"
        icon="error"
        title={problem.message}
        sha={problem.sha}
        onShow={onShow}
      >
        Can’t apply
      </State>
    );
  else if (session.simulating)
    prediction = (
      <State state="pending" icon="loading" title="Checking how git will apply it…">
        Checking…
      </State>
    );
  else if (!session.simulation?.supported)
    prediction = (
      <State
        state="unknown"
        icon="question"
        title={
          session.simulation?.skipped === 'git'
            ? 'Conflict prediction needs git 2.40 or newer'
            : session.simulation?.skipped === 'size'
              ? 'Too many commits to replay while you arrange them: conflicts are not predicted'
              : 'Conflicts could not be predicted'
        }
      >
        Not predicted
      </State>
    );
  else if (conflict)
    prediction = (
      <State
        state="conflict"
        icon="warning"
        title={`Conflicts in ${conflict.files?.join(', ')}`}
        sha={conflict.sha}
        onShow={onShow}
      >
        Conflict at {shortSha(conflict.sha)}
      </State>
    );
  else
    prediction = (
      <State state="clean" icon="pass" title="Predicted with git merge-tree, without touching your files">
        Applies cleanly
      </State>
    );
  return (
    <span className={styles.summary}>
      <span
        className={styles.counts}
        title={`${before} commit${before === 1 ? '' : 's'} become${before === 1 ? 's' : ''} ${after}${splits > 0 ? ' or more' : ''}`}
      >
        {before}
        <span className={styles.countsWord}> commit{before === 1 ? '' : 's'}</span>
        <Icon name="arrow-right" />
        <strong title={splits > 0 ? `${after} or more: split commits become several` : undefined}>
          {after}
          {splits > 0 ? '+' : ''}
        </strong>
      </span>
      {prediction}
    </span>
  );
}

/** One state of the header: a pill, which selects the commit it is about when there is one. */
function State({
  state,
  icon,
  title,
  sha,
  onShow,
  nudge,
  children,
}: {
  state: string;
  icon: string;
  title: string;
  sha?: string;
  onShow?: (sha: string) => void;
  /** Flashes once as it appears (a refused Apply). */
  nudge?: boolean;
  children: ReactNode;
}) {
  const content = (
    <>
      <Icon name={icon} spin={icon === 'loading'} />
      {/* In a narrow editor only the icon shows (the words stay for screen readers). */}
      <span className={styles.predictText}>{children}</span>
    </>
  );
  return sha && onShow ? (
    <button
      type="button"
      className={styles.predict}
      data-state={state}
      data-nudge={nudge || undefined}
      title={`${title} (click to select it)`}
      onClick={() => onShow(sha)}
    >
      {content}
    </button>
  ) : (
    <span className={styles.predict} data-state={state} data-nudge={nudge || undefined} title={title}>
      {content}
    </span>
  );
}

export function ActionBar({ session }: { session: RewriteSession }) {
  const selected = new Set(session.selection);
  const actions = new Set(session.entries.filter((e) => selected.has(e.sha)).map((e) => e.action));
  const current = actions.size === 1 ? [...actions][0] : undefined;
  const count = selected.size;
  return (
    <div className={styles.actionBar} role="toolbar" aria-label="Actions for the selected commits">
      <div className={styles.actions}>
        {ACTION_ORDER.map((action) => (
          <button
            key={action}
            type="button"
            className={styles.actionButton}
            data-action={action}
            aria-pressed={current === action}
            // Its name stays when a narrow editor shows only the icon.
            aria-label={ACTIONS[action].label}
            aria-keyshortcuts={ACTIONS[action].key.toUpperCase()}
            disabled={count === 0}
            title={`${ACTIONS[action].hint} (${ACTIONS[action].key.toUpperCase()})`}
            onClick={() => setAction(useRewrite.getState().session?.selection ?? [], action)}
          >
            <Icon name={ACTIONS[action].icon} />
            <span>{ACTIONS[action].label}</span>
            <kbd>{ACTIONS[action].key.toUpperCase()}</kbd>
          </button>
        ))}
      </div>
      <span className={styles.divider} />
      <ToolButton
        icon="arrow-up"
        label="Move up (newer)"
        shortcut="Alt+↑"
        disabled={count === 0}
        onClick={() => moveSelection('up')}
      />
      <ToolButton
        icon="arrow-down"
        label="Move down (older)"
        shortcut="Alt+↓"
        disabled={count === 0}
        onClick={() => moveSelection('down')}
      />
      <span className={styles.divider} />
      <button
        type="button"
        className={styles.textButton}
        onClick={resetArrangement}
        disabled={session.past.length === 0}
      >
        Start over
      </button>
      {autosquashCandidates(session.range.commits) > 0 ? (
        <button
          type="button"
          className={styles.textButton}
          title="Fold “fixup!”, “squash!” and “amend!” commits into the commits they name (like git rebase --autosquash)"
          onClick={() => arrange((entries, current) => autosquash(entries, current.range.commits))}
        >
          <Icon name="wand" /> Autosquash
        </button>
      ) : null}
      <span className={styles.spacer} />
      <span className={styles.selectionCount}>
        {count === 0 ? 'Nothing selected' : count === 1 ? '1 commit selected' : `${count} commits selected`}
      </span>
    </div>
  );
}

/**
 * What to know before applying: why it cannot be applied (with the ways out), the plan's warnings
 * and notes, and whether other branches move along. In a narrow editor the notes fold away behind
 * one line; what cannot be applied and the warnings always show in full.
 */
export function Footer({
  session,
  model,
  problem,
  conflict,
  onShow,
  onFixed,
}: {
  session: RewriteSession;
  model?: LogModel;
  problem?: Problem;
  /** The step the dry run expects git to stop at with a conflict. */
  conflict?: RewriteStep;
  /** Selects the commit a notice is about. */
  onShow: (sha: string) => void;
  /** After a way out was taken (its button is gone then). */
  onFixed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const plan = session.plan;
  const notices = (plan?.notices ?? []).filter((notice) => notice.level !== 'danger');
  const warnings = notices.filter((notice) => notice.level === 'warning');
  const notes = notices.filter((notice) => notice.level !== 'warning');
  const preview = plan?.rewrite;
  const branches = new Set(
    (model?.refs.refs ?? []).filter((ref) => ref.kind === 'branch').map((ref) => ref.short),
  );
  const movable = [...(preview?.strandedRefs ?? []), ...(preview?.updatedRefs ?? [])].filter((name) =>
    branches.has(name),
  );
  // A predicted conflict says what happens then (the header names the commit only).
  const stop = problem ? undefined : conflict;
  if (!problem && !stop && notices.length === 0 && movable.length === 0 && !session.error) return null;
  const above = !!problem || !!stop || !!session.error || warnings.length > 0;
  // A single note takes no more room than the line that would fold it.
  const foldable = notes.length > 0 && (above || notes.length > 1);
  return (
    <footer className={styles.footer} data-expanded={expanded || undefined}>
      {problem ? (
        <div
          key={session.refusals}
          className={styles.notice}
          data-level="danger"
          data-nudge={session.refusals > 0 || undefined}
        >
          <Icon name="error" />
          <span>
            {problem.sha ? (
              <button
                type="button"
                className={styles.noticeSha}
                title="Select it"
                onClick={() => onShow(problem.sha!)}
              >
                {shortSha(problem.sha)}
              </button>
            ) : null}{' '}
            {problem.message}
            {problem.fixes.map((fix) => (
              <button
                key={fix.label}
                type="button"
                className={styles.fix}
                title={fix.title}
                onClick={() => void Promise.resolve(fix.run()).then(onFixed)}
              >
                {fix.label}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      {session.error ? (
        <div className={styles.notice} data-level="danger">
          <Icon name="error" />
          <span>{session.error}</span>
        </div>
      ) : null}
      {stop ? (
        <div className={styles.notice} data-level="warning">
          <Icon name="warning" />
          <span>
            <button
              type="button"
              className={styles.noticeSha}
              title="Select it"
              onClick={() => onShow(stop.sha)}
            >
              {shortSha(stop.sha)}
            </button>{' '}
            is expected to conflict{stop.files?.length ? ` in ${stop.files.join(', ')}` : ''}. Git stops
            there: resolve it, then continue from the banner.
          </span>
        </div>
      ) : null}
      {[...warnings, ...notes].map((notice, index) => (
        <div
          key={index}
          className={styles.notice}
          data-level={notice.level}
          data-foldable={(foldable && notice.level !== 'warning') || undefined}
        >
          <Icon name={notice.level === 'warning' ? 'warning' : 'info'} />
          <span>{notice.text}</span>
        </div>
      ))}
      {foldable ? (
        <button
          type="button"
          className={styles.moreNotes}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="info" />
          {expanded
            ? 'Fewer notes'
            : `${notes.length}${above ? ' more' : ''} note${notes.length === 1 ? '' : 's'}`}
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
        </button>
      ) : null}
      {movable.length > 0 ? (
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={session.updateRefs}
            onChange={(event) => setUpdateRefs(event.target.checked)}
          />
          <span>
            Move {movable.join(', ')} along with {movable.length === 1 ? 'its commit' : 'their commits'}{' '}
            <code>--update-refs</code>
          </span>
        </label>
      ) : null}
    </footer>
  );
}
