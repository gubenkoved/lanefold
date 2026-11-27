import { AnimatePresence, motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { displayRev } from '../../../shared/oid';
import { groupRewrite, type RewriteStep } from '../../../shared/rewrite';
import { Icon } from '../../components/Icon';
import { shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import {
  applyProblem,
  applyRewrite,
  cancelRewrite,
  editMessage,
  foldCommits,
  holdApply,
  includeOlder,
  isArranged,
  isDirty,
  moveFocus,
  moveSelection,
  planRows,
  redoArrangement,
  reorder,
  resetGroupMessage,
  resultCommits,
  select,
  setAction,
  undoArrangement,
  useRewrite,
  type Arranged,
  type RewriteSession,
} from '../../state/rewrite';
import { ACTIONS, ACTION_ORDER, openActionMenu } from './actions';
import { ActionBar, Footer, Summary, ToolButton, type Problem } from './EditorBars';
import { olderBase } from './entryPoints';
import { ANIMATED_ROWS, BaseRow, DragHint, DragLabel, PlanRowItem, ROW_H } from './PlanList';
import { ResultPane } from './ResultPane';
import { moveInOrder, useRowDrag } from './useRowDrag';
import styles from './HistoryEditor.module.css';

export interface HistoryEditorProps {
  readonly session: RewriteSession;
  /** The log model (for branch pills at each commit). */
  readonly model?: LogModel;
  /** Lane color of the edited branch. */
  readonly color: string;
}

/** Visual interactive rebase: arrange commits, see the result and the exact git commands. */
export function HistoryEditor({ session, model, color }: HistoryEditorProps) {
  // Worked out again only when the arrangement changes (not for each selection or focus move).
  const { entries, range } = session;
  const rows = useMemo(() => planRows({ entries, range }), [entries, range]);
  const results = useMemo(() => resultCommits({ entries, range }), [entries, range]);
  const steps = useMemo(() => {
    const map = new Map<string, RewriteStep>();
    for (const step of session.simulation?.steps ?? []) map.set(step.sha, step);
    return map;
  }, [session.simulation]);
  const dirty = useMemo(() => isDirty({ entries, range }), [entries, range]);
  // A rebase can be applied as it opens: only an arrangement made since is asked about on Cancel.
  const arranged = useMemo(
    () => (range.onto ? isArranged({ entries, range }) : dirty),
    [entries, range, dirty],
  );
  const branch = range.branch ?? 'HEAD';
  const target = range.onto ? displayRev(range.onto.rev) : undefined;
  const alreadyThere = useMemo(() => new Set(range.alreadyThere), [range.alreadyThere]);
  const [pane, setPane] = useState<'result' | 'git'>('result');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const focusedGroup = rows.find((row) => row.entry.sha === session.focus)?.group;
  const conflictStep = session.simulation?.steps.find((step) => step.status === 'conflict');
  const { planning, plan } = session;
  const problem = useMemo(
    () => (dirty ? withFixes({ entries, range, planning, plan }, model) : undefined),
    [entries, range, planning, plan, model, dirty],
  );
  // Apply waits for a plan on its way (the click is kept), not for one that cannot be applied.
  const canApply = dirty && !problem && !session.applying;
  // Git is running the edit: nothing can be changed or cancelled any more.
  const running = session.applying && !session.planning;

  // The list takes keyboard focus when the editor opens (unless a message editor does).
  useLayoutEffect(() => {
    if (!session.editing) listRef.current?.focus({ preventScroll: true });
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // What the editor covers (the log of its tab, still mounted) is out of reach meanwhile: Tab
  // must not wander into controls nobody can see. Closed (applied or cancelled) with focus in
  // it, the editor hands focus back to the graph rather than to the page.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const covered = [...(section?.parentElement?.children ?? [])].filter(
      (element) => element !== section && (!element.hasAttribute('inert') || covers.has(element)),
    );
    for (const element of covered) cover(element, 1);
    const graph = section?.parentElement?.querySelector<HTMLElement>('[role="grid"]');
    return () => {
      for (const element of covered) cover(element, -1);
      if (section?.contains(document.activeElement)) graph?.focus({ preventScroll: true });
    };
  }, []);

  // Keep the focused row in view.
  useEffect(() => {
    if (!session.focus) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-sha="${session.focus}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [session.focus]);

  const cancel = () => {
    if (running) return;
    if (arranged && !confirmCancel) {
      // Discarding wins over an Apply still waiting for its plan.
      holdApply();
      setConfirmCancel(true);
      return;
    }
    cancelRewrite();
  };

  /** Selects a commit the header or a notice talks about, with the list focused. */
  const show = (sha: string) => {
    select(sha);
    listRef.current?.focus({ preventScroll: true });
  };

  /** Shortcuts that work anywhere in the editor (outside the message box for undo/redo). */
  const onEditorKey = (event: KeyboardEvent<HTMLElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const inText = (event.target as HTMLElement).closest('textarea, input') !== null;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && key === 'enter') {
      handled();
      void applyRewrite();
    } else if (!inText && mod && key === 'z' && !event.shiftKey) {
      handled();
      undoArrangement();
    } else if (!inText && mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
      handled();
      redoArrangement();
    } else if (!inText && event.key === 'Escape') {
      handled();
      if (confirmCancel) setConfirmCancel(false);
      else cancel();
    }
  };

  /** Navigation and actions on the commit list. */
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // The selection as it is now, not as last rendered: a click just before may not have
    // rendered yet, and the key must act on what was clicked.
    const live = useRewrite.getState().session ?? session;
    const selection = live.selection;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && key === 'a') {
      handled();
      const all = planRows(live);
      for (const row of all) select(row.entry.sha, row === all[0] ? 'single' : 'toggle');
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      // The action menu of the focused commit, as its chip opens it.
      handled();
      const sha = live.focus ?? selection[0];
      const chip = sha ? listRef.current?.querySelector(`[data-sha="${sha}"] [data-chip]`) : null;
      if (sha) openActionMenu(chip ?? listRef.current!, sha);
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      handled();
      moveSelection(event.key === 'ArrowUp' ? 'up' : 'down');
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      handled();
      moveFocus(event.key === 'ArrowUp' ? -1 : 1, event.shiftKey);
    } else if (event.key === 'Home' || event.key === 'End') {
      handled();
      moveFocus(event.key === 'Home' ? -rows.length : rows.length, event.shiftKey);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      handled();
      setAction(selection, 'drop');
    } else if (event.key === 'Enter' && !mod) {
      handled();
      const row = planRows(live).find((r) => r.entry.sha === live.focus);
      const head = row?.role === 'member' ? row.into : row?.role === 'head' ? row.entry.sha : undefined;
      if (head) editMessage(head);
    } else if (!mod && !event.altKey) {
      const action = ACTION_ORDER.find((a) => ACTIONS[a].key === key);
      if (action) {
        handled();
        setAction(selection, action);
      }
    }
  };

  const order = useMemo(() => rows.map((row) => row.entry.sha), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { drag, press } = useRowDrag({
    scrollRef,
    order,
    canFold: (sha) => session.entries.find((entry) => entry.sha === sha)?.action !== 'drop',
    onDrop: (shas, target) => {
      if (target.kind === 'move') reorder(moveInOrder(order, shas, target.index));
      else foldCommits(shas, target.sha, target.action);
    },
  });
  const orderRef = useRef(order);
  useLayoutEffect(() => {
    orderRef.current = order;
  });
  /** Starts a possible drag of a row: the selection when the row is in it, else the row. */
  const onPress = useCallback(
    (event: ReactPointerEvent, sha: string, click?: () => void) =>
      press(
        event,
        () => {
          const selection = useRewrite.getState().session?.selection ?? [];
          if (!selection.includes(sha)) return [sha];
          const selected = new Set(selection);
          return orderRef.current.filter((candidate) => selected.has(candidate));
        },
        click,
      ),
    [press],
  );
  // What each row shows, worked out once for all of them (rows re-render only when theirs changes).
  const selected = useMemo(() => new Set(session.selection), [session.selection]);
  const subjects = useMemo(
    () => new Map(session.range.commits.map((commit) => [commit.sha, commit.subject])),
    [session.range.commits],
  );
  const combined = useMemo(
    () =>
      new Set(
        groupRewrite(session.entries)
          .filter((group) => group.members.some((member) => member.action === 'squash'))
          .map((group) => group.head.sha),
      ),
    [session.entries],
  );

  return (
    <motion.section
      ref={sectionRef}
      className={styles.root}
      aria-label={target ? `Rebase ${branch} onto ${target}` : `Edit history of ${branch}`}
      data-rebase={target ? '' : undefined}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      onKeyDown={onEditorKey}
      // A click anywhere in the editor keeps focus in it (not on the page), so its keys still work.
      tabIndex={-1}
      // Ctrl+Z here undoes arrangement steps, not git operations.
      data-own-undo=""
    >
      <header className={styles.header}>
        <Icon name="git-pull-request-draft" className={styles.titleIcon} />
        <h2 className={styles.title}>
          <span className={styles.titleText}>{target ? 'Rebase' : 'Edit history of'}</span>{' '}
          <span
            className={styles.branch}
            style={{ ['--c' as string]: color }}
            // Its name, whole, where a narrow header shortens it.
            title={branch}
          >
            <Icon name="git-branch" />
            <span className={styles.branchName}>{branch}</span>
          </span>
          {target ? (
            <>
              {' '}
              <span className={styles.titleText}>onto</span>{' '}
              <span
                className={[styles.branch, styles.target].join(' ')}
                title={`${target} (${shortSha(range.onto!.sha)})`}
              >
                <Icon name="target" />
                <span className={styles.branchName}>{target}</span>
              </span>
            </>
          ) : null}
        </h2>
        <Summary session={session} conflict={conflictStep} problem={problem} dirty={dirty} onShow={show} />
        <span className={styles.spacer} />
        <div className={styles.headerTools}>
          <ToolButton
            icon="discard"
            label="Undo"
            shortcut="Ctrl+Z"
            disabled={session.past.length === 0 || session.applying}
            onClick={undoArrangement}
          />
          <ToolButton
            icon="redo"
            label="Redo"
            shortcut="Ctrl+Shift+Z"
            disabled={session.future.length === 0 || session.applying}
            onClick={redoArrangement}
          />
          <ToolButton
            icon="terminal"
            label="Git commands"
            pressed={pane === 'git'}
            className={styles.gitTool}
            onClick={() => setPane(pane === 'git' ? 'result' : 'git')}
          />
        </div>
        <button
          type="button"
          className={styles.cancel}
          disabled={running}
          title={running ? 'Git is applying the edit' : undefined}
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={[styles.apply, conflictStep && !problem ? styles.applyWarning : ''].join(' ')}
          disabled={!canApply}
          aria-busy={session.applying || undefined}
          title={
            session.applying
              ? 'Applying…'
              : !dirty
                ? 'Nothing changes yet'
                : (problem?.message ??
                  (conflictStep
                    ? 'Git will stop at the predicted conflict so you can resolve it (Ctrl+Enter)'
                    : 'Ctrl+Enter'))
          }
          onClick={() => void applyRewrite()}
        >
          {session.applying ? <Icon name="loading" spin /> : <Icon name="check" />}
          {target ? 'Rebase' : 'Apply'}
        </button>
      </header>

      <ActionBar session={session} />

      <AnimatePresence>
        {confirmCancel ? (
          <motion.div
            className={styles.confirm}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <Icon name="warning" />
            <span>Discard this arrangement? Nothing has been changed in the repository.</span>
            <button
              type="button"
              className={styles.confirmDanger}
              disabled={session.applying}
              onClick={cancelRewrite}
            >
              Discard
            </button>
            <button type="button" className={styles.confirmKeep} onClick={() => setConfirmCancel(false)}>
              Keep editing
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className={styles.main}>
        <div className={styles.planPane}>
          <div className={styles.columns} aria-hidden="true">
            <span />
            <span />
            <span>Action</span>
            <span>Commit (newest first)</span>
            <span className={styles.colAuthor}>Author</span>
            <span className={styles.colDate}>Date</span>
            <span className={styles.colSha}>Hash</span>
            <span />
          </div>
          <div
            ref={scrollRef}
            className={styles.list}
            data-dragging={drag ? '' : undefined}
            onMouseDown={(event) => {
              // A click in the free space below the rows keeps the keys on the list (instead of
              // the browser moving focus to the editor as a whole).
              if ((event.target as HTMLElement).closest('button, a, [role="option"]')) return;
              event.preventDefault();
              listRef.current?.focus({ preventScroll: true });
            }}
          >
            <div
              ref={listRef}
              className={styles.rows}
              tabIndex={0}
              role="listbox"
              aria-multiselectable="true"
              aria-label="Commits, newest first"
              aria-activedescendant={session.focus ? `rewrite-${session.focus}` : undefined}
              onKeyDown={onListKey}
            >
              {rows.map((row, index) => {
                const { entry, commit } = row;
                // A new message shows in place of the subject (reworded, or combined in a squash).
                const reworded =
                  row.role === 'head' &&
                  entry.message !== undefined &&
                  (entry.action === 'reword' || combined.has(entry.sha));
                return (
                  <PlanRowItem
                    key={entry.sha}
                    row={row}
                    index={index}
                    model={model}
                    color={color}
                    step={steps.get(entry.sha)}
                    problem={problem?.sha === entry.sha ? problem.message : undefined}
                    selected={selected.has(entry.sha)}
                    focused={session.focus === entry.sha}
                    inFocusedGroup={row.group !== undefined && row.group === focusedGroup}
                    subject={reworded ? (entry.message!.split('\n', 1)[0] ?? '') : commit.subject}
                    reworded={reworded}
                    intoSubject={row.into ? subjects.get(row.into) : undefined}
                    alreadyIn={alreadyThere.has(entry.sha) ? target : undefined}
                    dragged={!!drag?.shas.includes(entry.sha)}
                    dropTarget={drag?.target?.kind === 'fold' && drag.target.sha === entry.sha}
                    animate={rows.length <= ANIMATED_ROWS}
                    onPress={onPress}
                  />
                );
              })}
              {drag?.target?.kind === 'move' ? (
                <div
                  className={styles.insertion}
                  data-insertion=""
                  // Above the first row it stays inside the list, clear of the column headers.
                  style={{ top: Math.max(drag.target.index * ROW_H, 4) }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
            <BaseRow
              session={session}
              color={color}
              model={model}
              onInclude={(base) =>
                void includeOlder(base).then(() => listRef.current?.focus({ preventScroll: true }))
              }
            />
            <DragHint />
          </div>
          {drag ? <DragLabel drag={drag} session={session} /> : null}
        </div>
        <ResultPane
          session={session}
          results={results}
          steps={steps}
          color={color}
          focusedGroup={focusedGroup}
          problem={problem}
          pane={pane}
          onPane={setPane}
        />
      </div>

      <Footer
        session={session}
        model={model}
        problem={problem}
        conflict={dirty ? conflictStep : undefined}
        onShow={show}
        // The keys go back to the list.
        onFixed={() => listRef.current?.focus({ preventScroll: true })}
      />
      {/* Why it cannot be applied, said once as it happens and again for each refused Apply. */}
      <div className={styles.announce} aria-live="polite">
        {problem ? <span key={session.refusals}>Can’t apply: {problem.message}</span> : null}
      </div>
    </motion.section>
  );
}

/** How many editors cover an element (one closing while the next opens: both do for a moment). */
const covers = new WeakMap<Element, number>();

/** Takes an element out of reach (`inert`) while at least one editor covers it. */
function cover(element: Element, delta: 1 | -1): void {
  const count = (covers.get(element) ?? 0) + delta;
  covers.set(element, count);
  if (count > 0) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
}

/**
 * Why the arrangement cannot be applied, with the ways out the editor can offer: the commit an
 * oldest squash needs to fold into, or a message for a commit left without one.
 */
function withFixes(
  session: Arranged & Pick<RewriteSession, 'planning' | 'plan'>,
  model: LogModel | undefined,
): Problem | undefined {
  const problem = applyProblem(session);
  if (!problem) return undefined;
  const sha = problem.sha;
  const fixes: Problem['fixes'][number][] = [];
  if (sha && problem.kind === 'squash-first') {
    const base = session.range.base;
    const older = model && base ? olderBase(model, base, 1) : undefined;
    if (base && older) {
      fixes.push({
        label: `Include ${shortSha(base)}`,
        title: `Add ${shortSha(base)}, the commit below it, to the edit: it folds into that one`,
        run: () => includeOlder(older.base),
      });
    }
    fixes.push({
      label: 'Pick it instead',
      title: 'Keep it as a commit of its own',
      run: () => setAction([sha], 'pick'),
    });
  } else if (sha && problem.kind === 'no-message') {
    const group = groupRewrite(session.entries).find((candidate) => candidate.head.sha === sha);
    const combines = !!group?.members.some((member) => member.action === 'squash');
    fixes.push({
      label: combines ? 'Combine the messages again' : 'Use the original message',
      run: () => resetGroupMessage(sha),
    });
  }
  return { ...problem, fixes };
}
