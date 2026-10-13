import { useRef, useState, type FormEvent } from 'react';
import type { OpState, SplitState } from '../../../shared/operations';
import { create } from 'zustand';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { useHost } from '../../hostContext';
import { indexSettled, useIndexChanges } from '../../state/indexChanges';
import { runOperation, useOperations } from '../../state/operations';
import { fetchCommitDetails } from '../../state/queries';
import { describeOperation, patchNotApplied } from '../ops/OpBanner';
import styles from './CommitBox.module.css';

interface Draft {
  readonly message: string;
  readonly amend: boolean;
  readonly signoff: boolean;
}

/** The commit message being written, per repository (survives switching commits and tabs). */
const useDrafts = create<{ drafts: Readonly<Record<string, Draft>> }>(() => ({ drafts: {} }));
const EMPTY: Draft = { message: '', amend: false, signoff: false };

function updateDraft(repoId: string, patch: Partial<Draft>): void {
  useDrafts.setState((state) => ({
    drafts: { ...state.drafts, [repoId]: { ...(state.drafts[repoId] ?? EMPTY), ...patch } },
  }));
}

export interface CommitBoxProps {
  readonly repoId: string;
  readonly branch?: string;
  /** The current HEAD commit (for amending), if any. */
  readonly head?: string;
  readonly staged: number;
  readonly conflicted: number;
  /** The file lists are being read again after a change: the counts may be behind. */
  readonly refreshing?: boolean;
}

/** Message, amend and sign-off, and the buttons that commit (and push). */
export function CommitBox(props: CommitBoxProps) {
  const opState = useOperations((state) => state.opState);
  // Splitting a commit: each part is an ordinary commit (the banner continues the history edit).
  if (opState?.split?.opened && !opState.running) return <NewCommitBox {...props} split={opState.split} />;
  // While git is stopped in a merge, pick, revert or rebase, committing means going on with it.
  if (opState?.kind && opState.kind !== 'bisect' && !opState.running)
    return <ContinueBox state={opState} conflicted={props.conflicted} />;
  return <NewCommitBox {...props} />;
}

/** Concludes the step git stopped at: the merge commit's message can be edited first. */
function ContinueBox({ state, conflicted }: { state: OpState; conflicted: number }) {
  const busy = useOperations((s) => !!s.starting || !!s.running);
  const prepared = state.message ?? '';
  // The message follows git's until edited (a new stop starts from git's again).
  const [edited, setEdited] = useState<{ for: string | undefined; text: string } | undefined>();
  const message = edited && edited.for === state.commit ? edited.text : prepared;
  const { icon, title, detail } = describeOperation(state);
  const merge = state.kind === 'merge';
  const changes = state.changes ? state.changes.staged + state.changes.unstaged : 0;
  const label = merge
    ? 'Conclude merge'
    : state.editStop
      ? changes > 0
        ? 'Amend & continue'
        : 'Continue'
      : `Continue ${state.kind === 'am' ? 'applying' : state.kind}`;
  const reason =
    conflicted > 0
      ? `Resolve ${conflicted} conflict${conflicted === 1 ? '' : 's'} first`
      : patchNotApplied(state)
        ? 'The patch did not apply: stage its changes by hand, or skip it'
        : merge && !message.trim()
          ? 'Write a message for the merge commit'
          : undefined;
  const run = () => {
    if (reason || busy) return;
    void runOperation({
      kind: 'continue',
      // Only a merge's message can be set; git's own needs no repeating.
      message: merge && message.trim() !== prepared.trim() ? message : undefined,
    });
  };
  // Stopped at a commit to split that is still whole: it can be taken apart from here too.
  const splittable = !!state.split && !state.split.opened && conflicted === 0;
  return (
    <form
      className={[styles.box, styles.continue].join(' ')}
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        run();
      }}
    >
      <div className={styles.opHead}>
        <Icon name={icon} />
        <span className={styles.opTitle}>{title}</span>
      </div>
      {detail ? <div className={styles.opDetail}>{detail}</div> : null}
      {merge ? (
        <textarea
          className={styles.message}
          value={message}
          rows={Math.min(8, Math.max(3, message.split('\n').length + 1))}
          placeholder="Message of the merge commit (Ctrl+Enter concludes the merge)"
          aria-label="Merge commit message"
          spellCheck
          onChange={(event) => setEdited({ for: state.commit, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              run();
            }
          }}
        />
      ) : state.message ? (
        <div className={styles.prepared} title="The message git uses for this commit">
          {state.message.split('\n')[0]}
        </div>
      ) : null}
      <div className={styles.buttons}>
        {splittable ? (
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            title="Put its changes back in the working tree, uncommitted, to commit them in parts"
            onClick={() => void runOperation({ kind: 'startSplit' })}
          >
            <Icon name="split-vertical" />
            Split
          </button>
        ) : null}
        <button
          type="submit"
          className={splittable ? styles.secondary : styles.primary}
          disabled={!!reason || busy}
          title={reason ?? (splittable ? 'Keep it whole and go on' : undefined)}
        >
          <Icon name={merge ? 'git-merge' : 'debug-continue'} />
          {label}
        </button>
      </div>
      {reason ? (
        <div className={styles.reason} role="status">
          <Icon name={conflicted > 0 ? 'warning' : 'info'} /> {reason}
        </div>
      ) : null}
    </form>
  );
}

function NewCommitBox({
  repoId,
  branch,
  head,
  staged,
  conflicted,
  refreshing,
  split,
}: CommitBoxProps & {
  /** Splitting this commit: the box commits its next part (no amending, no pushing mid-edit). */
  readonly split?: SplitState;
}) {
  const host = useHost();
  const stored = useDrafts((state) => state.drafts[repoId] ?? EMPTY);
  const draft = split ? { ...stored, amend: false } : stored;
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Not while another operation is planned or run (a double click would commit twice).
  const busy = useOperations((state) => !!state.starting || !!state.running);
  // Right after staging, the counts trail git for a moment: until they catch up, a commit is not
  // refused on their word (git is asked when it runs).
  const staging = useIndexChanges((state) => (state.pending[repoId] ?? 0) > 0);
  const settled = !staging && !refreshing;
  const canCommit =
    !busy &&
    conflicted === 0 &&
    (draft.amend ? !!head : (staged > 0 || !settled) && draft.message.trim().length > 0);
  const part = split ? split.parts.length + 1 : 0;
  const reason =
    conflicted > 0
      ? 'Resolve the conflicts first'
      : !draft.amend && staged === 0 && settled
        ? 'Stage the changes to commit first'
        : !draft.amend && !draft.message.trim()
          ? 'Write a commit message'
          : undefined;

  const toggleAmend = async (amend: boolean) => {
    updateDraft(repoId, { amend });
    // Amending starts from the last commit's message, like `git commit --amend`.
    if (amend && head && !draft.message.trim()) {
      try {
        const details = await fetchCommitDetails(host.rpc, repoId, head);
        updateDraft(repoId, {
          message: details.body ? `${details.subject}\n\n${details.body}` : details.subject,
        });
      } catch {
        // Keep the box empty: an empty message keeps the last one anyway.
      }
    }
  };

  const commit = async (andPush: boolean) => {
    if (!canCommit) {
      if (reason) toast(reason);
      return;
    }
    const message = draft.message;
    if (!draft.amend && staged === 0) {
      // The counts have not caught up yet: wait for git to finish staging, then ask it.
      await indexSettled(repoId);
      const tree = await host.rpc.call('repo.workingTree', { repoId }).catch(() => undefined);
      if (!tree?.staged) {
        toast('Stage the changes to commit first');
        return;
      }
    }
    void runOperation(
      { kind: 'commit', message, amend: draft.amend, signoff: draft.signoff },
      {
        onDone: (result) => {
          if (result.status !== 'done') return;
          updateDraft(repoId, { message: '', amend: false });
          if (andPush && !split) void runOperation({ kind: 'push' });
        },
      },
    );
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void commit(false);
  };

  return (
    <form
      className={styles.box}
      onSubmit={onSubmit}
      aria-label="Commit"
      // In a short pane it scrolls with the lists: once in use, all of it comes into view.
      onFocus={(event) => {
        const form = event.currentTarget;
        requestAnimationFrame(() => form.scrollIntoView({ block: 'nearest' }));
      }}
    >
      {split ? (
        <div className={styles.splitHead}>
          <Icon name="split-vertical" />
          <span className={styles.opTitle} title={split.message}>
            Part {part} of {split.commit.slice(0, 8)} “{split.subject}”
          </span>
          <button
            type="button"
            className={styles.link}
            title="Start from the message of the commit being split"
            onClick={() => {
              updateDraft(repoId, { message: split.message });
              textRef.current?.focus();
            }}
          >
            Original message
          </button>
        </div>
      ) : null}
      <textarea
        ref={textRef}
        className={styles.message}
        value={draft.message}
        rows={Math.min(8, Math.max(3, draft.message.split('\n').length + 1))}
        placeholder={
          split
            ? `Message of part ${part} (Ctrl+Enter commits)`
            : draft.amend
              ? 'Message (empty keeps the last one)'
              : `Commit message${branch ? ` for ${branch}` : ''} (Ctrl+Enter commits)`
        }
        aria-label="Commit message"
        spellCheck
        onChange={(event) => updateDraft(repoId, { message: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit(event.shiftKey);
          }
        }}
      />
      <div className={styles.row}>
        {split ? null : (
          <label
            className={styles.option}
            title="Replace the last commit with one that also has the staged changes"
          >
            <input
              type="checkbox"
              checked={draft.amend}
              disabled={!head}
              onChange={(event) => void toggleAmend(event.target.checked)}
            />
            Amend
          </label>
        )}
        <label className={styles.option} title="Add a “Signed-off-by” line with your name">
          <input
            type="checkbox"
            checked={draft.signoff}
            onChange={(event) => updateDraft(repoId, { signoff: event.target.checked })}
          />
          Sign off
        </label>
      </div>
      {!branch && head && !split ? (
        // Detached HEAD: a commit made here is kept only by HEAD until a branch points at it.
        <div className={styles.detached} role="note">
          <Icon name="warning" />
          <span>Not on a branch: the commit will belong to no branch.</span>
          <button
            type="button"
            className={styles.link}
            onClick={() => void runOperation({ kind: 'createBranch', name: '', at: head, checkout: true })}
          >
            Create a branch…
          </button>
        </div>
      ) : null}
      <div className={styles.buttons}>
        <button type="submit" className={styles.primary} disabled={!canCommit} title={reason ?? 'Ctrl+Enter'}>
          <Icon name="check" />
          {draft.amend
            ? 'Amend last commit'
            : staged > 0
              ? `Commit ${staged} file${staged === 1 ? '' : 's'}`
              : 'Commit'}
        </button>
        {split ? null : (
          <button
            type="button"
            className={styles.secondary}
            disabled={!canCommit}
            title={reason ?? 'Commit, then push (Ctrl+Shift+Enter)'}
            onClick={() => void commit(true)}
          >
            <Icon name="arrow-up" /> {draft.amend ? 'Amend & Push' : 'Commit & Push'}
          </button>
        )}
      </div>
    </form>
  );
}
