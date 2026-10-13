import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { OpState, SplitState } from '../../../shared/operations';
import { errorText } from '../../bridge/errorText';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { shortSha } from '../../graph/format';
import { useHost } from '../../hostContext';
import { refreshOpState, runOperation, useOperations } from '../../state/operations';
import { showInLog, useApp } from '../../state/store';
import { SubmoduleConflictRow } from './SubmoduleConflict';
import styles from './OpBanner.module.css';

/** A patch git stopped at without applying any of it (nothing staged, no conflicts). */
export function patchNotApplied(state: OpState): boolean {
  return state.kind === 'am' && state.conflicts.length === 0 && (state.changes?.staged ?? 0) === 0;
}

/** A commit’s subject for a button: in quotes, shortened (undefined when there is none). */
function quoted(subject: string | undefined, max = 28): string | undefined {
  if (!subject) return undefined;
  return `“${subject.length > max ? `${subject.slice(0, max - 1)}…` : subject}”`;
}

/** The operation in progress in a few words: an icon, a title and a detail line. */
export function describeOperation(state: OpState): { icon: string; title: string; detail?: string } {
  const into = state.branch ? ` into ${state.branch}` : '';
  const commit = state.commit
    ? `${shortSha(state.commit)}${state.commitSubject ? ` “${state.commitSubject}”` : ''}`
    : '';
  const step = state.step && state.total ? `step ${state.step} of ${state.total}` : '';
  // The operation as it was started names the stop: a pull stops in a merge or a rebase, an
  // amend of an older commit in a rebase.
  if (state.started?.kind === 'pull' && (state.kind === 'rebase' || state.kind === 'merge')) {
    return {
      icon: 'repo-pull',
      title: `Pulling ${state.branch ?? 'HEAD'}`,
      detail: [
        state.kind === 'rebase'
          ? `rebasing onto ${state.ontoRef ?? shortSha(state.onto)}`
          : `merging ${state.incomingRef ?? shortSha(state.commit)}`,
        step,
        state.kind === 'rebase' && commit ? `at ${commit}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (state.started?.kind === 'amendInto' && state.kind === 'rebase' && !state.editStop) {
    return {
      icon: 'edit',
      title: state.started.title.replace(/^Amend\b/, 'Amending'),
      detail: [step, commit ? `at ${commit}` : ''].filter(Boolean).join(' · '),
    };
  }
  switch (state.kind) {
    case 'merge':
      return {
        icon: 'git-merge',
        title: `Merging ${state.incomingRef ?? (shortSha(state.commit) || 'a commit')}${into}`,
        detail: commit || undefined,
      };
    case 'rebase':
      // A commit being split (after its conflicts, if any, are resolved).
      if (state.split && state.conflicts.length === 0) {
        const parts = state.split.parts.length;
        const subject = state.split.subject;
        const quoted = subject.length > 60 ? `${subject.slice(0, 59)}…` : subject;
        const name = `${shortSha(state.split.commit)}${subject ? ` “${quoted}”` : ''}`;
        return {
          icon: 'split-vertical',
          title: state.split.opened ? `Splitting ${name}` : `Stopped to split ${name}`,
          detail: [
            state.step && state.total ? `step ${state.step} of ${state.total}` : '',
            state.split.opened
              ? parts === 0
                ? 'no part committed yet'
                : `${parts} part${parts === 1 ? '' : 's'} committed`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        };
      }
      if (state.editStop) {
        return {
          icon: 'debug-pause',
          title: `Stopped to edit ${commit || 'a commit'}`,
          detail: [
            state.step && state.total ? `step ${state.step} of ${state.total}` : '',
            'what you change now goes into it',
          ]
            .filter(Boolean)
            .join(' · '),
        };
      }
      return {
        icon: state.historyEdit ? 'git-pull-request-draft' : 'git-pull-request',
        title: state.historyEdit
          ? `Editing history of ${state.branch ?? 'HEAD'}`
          : `Rebasing ${state.branch ?? 'HEAD'}${state.onto ? ` onto ${state.ontoRef ?? shortSha(state.onto)}` : ''}`,
        detail: [
          state.step && state.total ? `step ${state.step} of ${state.total}` : '',
          commit ? `at ${commit}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'cherry-pick':
      return {
        icon: 'git-commit',
        title: `Cherry-picking${state.branch ? ` onto ${state.branch}` : ''}`,
        detail: commit,
      };
    case 'revert':
      return { icon: 'discard', title: 'Reverting', detail: commit };
    case 'am':
      return {
        icon: 'mail',
        title: 'Applying patches',
        detail:
          [
            state.step ? `patch ${state.step} of ${state.total}` : '',
            state.commitSubject ? `“${state.commitSubject}”` : '',
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
      };
    case 'bisect': {
      const bisect = state.bisect;
      if (bisect?.firstBad) {
        return {
          icon: 'pass-filled',
          title: 'Found the first bad commit',
          detail: `${shortSha(bisect.firstBad)}${bisect.firstBadSubject ? ` “${bisect.firstBadSubject}”` : ''}`,
        };
      }
      return {
        icon: 'search',
        title: 'Bisecting',
        detail: bisect
          ? [
              `${bisect.remaining} suspect${bisect.remaining === 1 ? '' : 's'}`,
              `~${bisect.steps} more test${bisect.steps === 1 ? '' : 's'}`,
              bisect.current
                ? `testing ${shortSha(bisect.current)}${bisect.currentSubject ? ` “${bisect.currentSubject}”` : ''}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined,
      };
    }
    default:
      return { icon: 'info', title: 'Operation in progress' };
  }
}

/**
 * Sides of a conflict in plain words, named by what they are — a branch, or the commit being
 * applied by its subject: never "ours/theirs", which flip meaning in a rebase.
 */
export function sideLabels(state: OpState): {
  /** Button labels. */
  current: string;
  incoming: string;
  /** Short names of the sides (merge editor titles). */
  currentName: string;
  incomingName: string;
  /** What each side is, in a sentence. */
  currentTitle: string;
  incomingTitle: string;
} {
  const subject = state.commitSubject ? ` “${state.commitSubject}”` : '';
  // The commit being applied, as a button names it: its subject, else its short name.
  const applied = quoted(state.commitSubject) ?? (shortSha(state.commit) || undefined);
  if (state.kind === 'rebase') {
    // A history edit replays the branch's own commits onto the history edited so far.
    const branch = state.branch ?? 'HEAD';
    const onto = state.historyEdit ? `${branch} as edited so far` : (state.ontoRef ?? 'upstream');
    const replayed = shortSha(state.commit) || 'replayed';
    return {
      current: `Keep ${state.historyEdit ? branch : onto}`,
      incoming: `Use ${applied ?? 'the replayed commit'}`,
      currentName: state.historyEdit ? `${branch} (edited so far)` : onto,
      incomingName: `${replayed}${subject}`,
      currentTitle: state.historyEdit
        ? `The version in ${onto}, before this commit`
        : `The version in ${onto}, which the commits are replayed onto`,
      incomingTitle: `The version in ${shortSha(state.commit) || 'the commit being replayed'}${subject}`,
    };
  }
  const incomingName = state.incomingRef ?? (shortSha(state.commit) || 'incoming');
  const what =
    state.kind === 'revert'
      ? 'the revert'
      : state.kind === 'cherry-pick'
        ? `the picked commit ${shortSha(state.commit)}${subject}`
        : `${incomingName}${state.incomingRef && state.commit ? ` (${shortSha(state.commit)})` : ''}`;
  return {
    current: `Keep ${state.branch ?? 'current'}`,
    incoming:
      state.kind === 'revert'
        ? 'Use the revert'
        : state.kind === 'cherry-pick'
          ? `Use ${applied ?? 'the picked commit'}`
          : `Use ${state.incomingRef ?? applied ?? 'incoming'}`,
    currentName: state.branch ?? 'Current',
    incomingName:
      state.kind === 'revert'
        ? `Revert of ${shortSha(state.commit)}${subject}`
        : state.kind === 'cherry-pick'
          ? `${shortSha(state.commit)}${subject}`
          : incomingName,
    currentTitle: `The version in ${state.branch ?? 'the current branch'} (HEAD)`,
    incomingTitle: `The version from ${what}`,
  };
}

/** Shown while git is stopped in a merge, rebase, cherry-pick…: progress, conflicts, next steps. */
export function OpBanner() {
  const host = useHost();
  const state = useOperations((s) => s.opState);
  const repoId = useApp((s) => s.activeRepoId);
  // While Lanefold itself runs the operation, git's state files are only mid-flight.
  const visible = !!state?.kind && !state.running && !!repoId;
  // One step at a time: a second click while the first runs does nothing.
  const starting = useOperations((s) => !!s.starting || !!s.running);

  // A commit just taken apart: its changes come into view (the files to stage, the commit box).
  const splitting = state?.split?.opened ? state.split.commit : undefined;
  useEffect(() => {
    // The uncommitted changes are the row with the all-zero ID.
    if (splitting && repoId) showInLog(repoId, '0'.repeat(splitting.length));
  }, [splitting, repoId]);

  // A new stop (conflicts, say) takes focus when nothing else has it: after the history editor
  // or a sheet that started it closes, focus would otherwise fall to the page. So does what is
  // left once a file is resolved (its row, which had focus, is gone).
  const bannerRef = useRef<HTMLElement>(null);
  const stop =
    visible && state
      ? `${state.kind}:${state.commit ?? ''}:${state.step ?? ''}:${state.conflicts.length}`
      : undefined;
  useEffect(() => {
    if (!stop) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const banner = bannerRef.current;
      const target =
        banner?.querySelector<HTMLElement>('[data-conflict-file]') ??
        banner?.querySelector<HTMLElement>('button:not(:disabled)') ??
        banner;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [stop]);

  const call = async (action: () => Promise<unknown>, failure: string) => {
    try {
      const result = (await action()) as { backup?: string } | undefined;
      if (repoId) void refreshOpState(repoId);
      if (result?.backup)
        toast(`Your edited version is kept as ${result.backup}`, {
          detail: 'The file had changes since git stopped; they are in that copy.',
        });
    } catch (error) {
      toast(failure, { kind: 'error', detail: errorText(error) });
    }
  };

  return (
    <AnimatePresence initial={false}>
      {visible && state ? (
        <motion.section
          ref={bannerRef}
          tabIndex={-1}
          className={styles.banner}
          aria-label="Operation in progress"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 40 }}
        >
          {(() => {
            const { icon, title, detail } = describeOperation(state);
            const sides = sideLabels(state);
            const conflicts = state.conflicts;
            // Submodules are listed apart: a commit to choose for each, never a text merge.
            const submodulePaths = new Set(state.submodules?.map((conflict) => conflict.path));
            const fileConflicts = conflicts.filter((path) => !submodulePaths.has(path));
            // Splitting: Continue commits what is left of the commit (it amends nothing).
            const split = conflicts.length === 0 ? state.split : undefined;
            // A step git could not carry out (a file it could not write): Retry runs it again.
            const failedStep = conflicts.length === 0 ? state.failedStep : undefined;
            // Taken apart, no part committed yet: committing a part is the way on; Continue now
            // would end the split with the commit as it was.
            const firstPart = !!split?.opened && split.parts.length === 0;
            const amend =
              !split?.opened &&
              state.editStop &&
              !!state.changes &&
              state.changes.staged + state.changes.unstaged > 0;
            // `git am` (without --3way) stops with nothing applied when a patch does not fit.
            const notApplied = patchNotApplied(state);
            return (
              <div className={styles.inner}>
                <div className={styles.head}>
                  {/* The icon stays with the title, which wraps when it is long. */}
                  <span className={styles.what}>
                    <Icon name={icon} className={styles.icon} />
                    <strong>{title}</strong>
                  </span>
                  {detail ? <span className={styles.detail}>{detail}</span> : null}
                  {conflicts.length > 0 ? (
                    <span className={styles.count}>
                      {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}
                    </span>
                  ) : notApplied ? (
                    <span
                      className={styles.count}
                      title="Git could not apply this patch. Apply its changes by hand and stage them, then continue, or skip it."
                    >
                      did not apply
                    </span>
                  ) : failedStep ? (
                    <span className={styles.count}>could not apply</span>
                  ) : state.kind !== 'bisect' && !state.editStop && !split ? (
                    <span className={styles.ready}>
                      <Icon name="pass" /> ready to continue
                    </span>
                  ) : null}
                  <span className={styles.spacer} />
                  {/* The buttons stay together: at the end of the line, or on a line of their own. */}
                  <span className={styles.actions}>
                    {split && !split.opened ? (
                      <button
                        type="button"
                        className={styles.primary}
                        disabled={starting}
                        title="Put its changes back in the working tree, uncommitted, to commit them in parts"
                        onClick={() => void runOperation({ kind: 'startSplit' })}
                      >
                        <Icon name="split-vertical" /> Split
                      </button>
                    ) : null}
                    {firstPart && repoId ? (
                      <button
                        type="button"
                        className={styles.primary}
                        disabled={starting}
                        title="Stage the changes that belong in the first part, then write its message and commit"
                        onClick={() => commitPart(repoId, split!.commit)}
                      >
                        <Icon name="git-commit" /> Commit part 1…
                      </button>
                    ) : null}
                    {state.kind !== 'bisect' ? (
                      <button
                        type="button"
                        className={(split && !split.opened) || firstPart ? styles.secondary : styles.primary}
                        disabled={conflicts.length > 0 || notApplied || starting}
                        title={
                          conflicts.length > 0
                            ? 'Resolve the conflicts first'
                            : notApplied
                              ? 'Apply the patch’s changes and stage them first (or skip it)'
                              : failedStep
                                ? 'Run the step again: what it left half-done is put back first'
                                : firstPart
                                  ? 'No part is committed yet: continuing keeps the commit whole'
                                  : split?.opened
                                    ? 'Commit what is left with the original message and author, then go on'
                                    : split
                                      ? 'Keep it whole and go on'
                                      : undefined
                        }
                        // Before any part, ending the split is reviewed first (it keeps the commit whole).
                        onClick={() => void runOperation({ kind: 'continue' }, { review: firstPart })}
                      >
                        {failedStep ? 'Retry' : amend ? 'Amend & continue' : 'Continue'}
                      </button>
                    ) : null}
                    {(state.kind === 'rebase' && !state.editStop) ||
                    state.kind === 'cherry-pick' ||
                    state.kind === 'revert' ||
                    state.kind === 'am' ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={starting}
                        onClick={() => void runOperation({ kind: 'skip' }, { review: true })}
                      >
                        Skip
                      </button>
                    ) : null}
                    {state.kind === 'bisect' && !state.bisect?.firstBad ? (
                      <>
                        <button
                          type="button"
                          className={styles.primary}
                          title="The checked-out commit does not have the problem (git bisect good)"
                          disabled={starting}
                          onClick={() => void runOperation({ kind: 'bisectMark', verdict: 'good' })}
                        >
                          <Icon name="pass" /> Good
                        </button>
                        <button
                          type="button"
                          className={styles.primary}
                          title="The checked-out commit has the problem (git bisect bad)"
                          disabled={starting}
                          onClick={() => void runOperation({ kind: 'bisectMark', verdict: 'bad' })}
                        >
                          <Icon name="error" /> Bad
                        </button>
                        <button
                          type="button"
                          className={styles.secondary}
                          title="This commit cannot be tested: try another (git bisect skip)"
                          disabled={starting}
                          onClick={() => void runOperation({ kind: 'bisectMark', verdict: 'skip' })}
                        >
                          Skip
                        </button>
                      </>
                    ) : null}
                    {state.kind === 'bisect' && state.bisect?.firstBad ? (
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => repoId && showInLog(repoId, state.bisect!.firstBad!)}
                      >
                        Show it
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.secondary}
                      title={
                        state.kind === 'bisect'
                          ? 'Go back to where the bisect started (git bisect reset)'
                          : undefined
                      }
                      disabled={starting}
                      onClick={() => void runOperation({ kind: 'abort' }, { review: conflicts.length > 0 })}
                    >
                      {state.kind === 'bisect' ? 'Stop bisecting' : 'Abort'}
                    </button>
                  </span>
                </div>
                {failedStep ? (
                  <p className={styles.reason}>
                    <Icon name="warning" className={styles.conflictIcon} />
                    <span>
                      {failedStep.reason ??
                        `Git could not apply ${shortSha(failedStep.commit)}. The Git Console shows what it printed.`}
                    </span>
                  </p>
                ) : null}
                {split ? <SplitNote state={state} split={split} repoId={repoId} /> : null}
                {conflicts.length > 0 ? (
                  <ul className={styles.files}>
                    {fileConflicts.map((path) => (
                      <li key={path} className={styles.file}>
                        <Icon name="warning" className={styles.conflictIcon} />
                        <button
                          type="button"
                          className={styles.path}
                          data-conflict-file
                          title={`Resolve in the 3-way merge editor: ${sides.currentTitle.toLowerCase()} and ${sides.incomingTitle.toLowerCase()}, side by side`}
                          onClick={() =>
                            void host.rpc
                              .call('conflict.mergeEditor', {
                                repoId: repoId!,
                                path,
                                current: { title: sides.currentName, detail: sides.currentTitle },
                                incoming: { title: sides.incomingName, detail: sides.incomingTitle },
                              })
                              .catch((error: unknown) =>
                                toast('Could not open the merge editor', {
                                  kind: 'error',
                                  detail: errorText(error),
                                }),
                              )
                          }
                        >
                          {path}
                        </button>
                        <button
                          type="button"
                          className={[styles.small, styles.iconOnly].join(' ')}
                          title="Open the file with its conflict markers"
                          aria-label={`Open ${path} with its conflict markers`}
                          onClick={() => void host.rpc.call('file.open', { repoId: repoId!, path })}
                        >
                          <Icon name="go-to-file" />
                        </button>
                        {/* Right-aligned; on a line of their own when the banner is narrow. */}
                        <span className={styles.actions}>
                          <button
                            type="button"
                            className={styles.small}
                            title={`${sides.currentTitle}: replace the file with it (the conflict stays open until you mark it resolved)`}
                            onClick={() =>
                              void call(
                                () => host.rpc.call('conflict.take', { repoId: repoId!, path, side: 'ours' }),
                                'Could not take that side',
                              )
                            }
                          >
                            {sides.current}
                          </button>
                          <button
                            type="button"
                            className={styles.small}
                            title={`${sides.incomingTitle}: replace the file with it (the conflict stays open until you mark it resolved)`}
                            onClick={() =>
                              void call(
                                () =>
                                  host.rpc.call('conflict.take', { repoId: repoId!, path, side: 'theirs' }),
                                'Could not take that side',
                              )
                            }
                          >
                            {sides.incoming}
                          </button>
                          <button
                            type="button"
                            className={styles.small}
                            title="Bring back the conflict markers"
                            onClick={() =>
                              void call(
                                () => host.rpc.call('conflict.restore', { repoId: repoId!, path }),
                                'Could not restore the markers',
                              )
                            }
                          >
                            <Icon name="discard" />
                          </button>
                          <button
                            type="button"
                            className={[styles.small, styles.resolve].join(' ')}
                            title="Stage the file as resolved"
                            onClick={() =>
                              void call(
                                () =>
                                  host.rpc.call('conflict.markResolved', { repoId: repoId!, paths: [path] }),
                                'Could not mark it resolved',
                              )
                            }
                          >
                            <Icon name="check" /> Resolved
                          </button>
                        </span>
                      </li>
                    ))}
                    {state.submodules?.map((conflict) => (
                      <SubmoduleConflictRow
                        key={conflict.path}
                        repoId={repoId!}
                        kind={state.kind}
                        conflict={conflict}
                        sides={sides}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })()}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Shows the uncommitted changes of a commit being split and puts the cursor in the commit box
 * (the details pane's, once the row is selected): where its next part is committed.
 */
function commitPart(repoId: string, commit: string): void {
  showInLog(repoId, '0'.repeat(commit.length));
  let tries = 0;
  const focus = () => {
    const box = document.querySelector<HTMLTextAreaElement>('form[aria-label="Commit"] textarea');
    if (box) box.focus();
    else if (++tries < 30) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}

/** While a commit is split: what to do, and the parts committed so far (each shown in the graph on click). */
function SplitNote({
  state,
  split,
  repoId,
}: {
  state: OpState;
  split: SplitState;
  repoId: string | undefined;
}) {
  return (
    <div className={styles.split}>
      <p className={styles.note}>
        {split.opened
          ? 'Its changes are uncommitted now. Stage part of them and commit; repeat as needed. Continue commits whatever is left with the original message and author.'
          : state.editStop
            ? 'It is still whole. Split puts its changes back in the working tree, uncommitted, to commit them in parts; Continue keeps it whole.'
            : 'Its conflicts are resolved. Split puts the result back in the working tree, uncommitted, to commit it in parts; Continue keeps it whole.'}
        {split.opened && repoId ? (
          <>
            {' '}
            <button
              type="button"
              className={styles.show}
              onClick={() => showInLog(repoId, '0'.repeat(split.commit.length))}
            >
              Show the changes
            </button>
          </>
        ) : null}
      </p>
      {split.parts.length > 0 ? (
        <ol className={styles.parts} aria-label="Parts committed so far">
          {split.parts.map((part, index) => (
            <li key={part.sha}>
              <button
                type="button"
                className={styles.part}
                title="Show it in the graph"
                onClick={() => repoId && showInLog(repoId, part.sha)}
              >
                <span className={styles.partIndex}>{index + 1}</span>
                <code className={styles.partSha}>{shortSha(part.sha)}</code>
                <span className={styles.partSubject}>{part.subject}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
