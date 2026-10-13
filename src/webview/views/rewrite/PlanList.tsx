/*
 * The commit list of the history editor: rows with their action, the lane and squash brackets,
 * what a drag would do, and the base the edit starts after.
 */

import { motion } from 'motion/react';
import { memo, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { RefInfo } from '../../../shared/models';
import type { RewriteEntry, RewriteStep } from '../../../shared/rewrite';
import { Icon } from '../../components/Icon';
import { relativeTime, shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import { editMessage, select, type PlanRow, type RewriteSession } from '../../state/rewrite';
import { Avatar } from '../log/parts';
import { ACTIONS, openActionMenu } from './actions';
import { olderBase } from './entryPoints';
import { besidePointer } from './placement';
import type { RowDrag } from './useRowDrag';
import styles from './HistoryEditor.module.css';

export const ROW_H = 32;
/** Beyond this many rows they no longer glide to new places (see {@link PlanRowItem}). */
export const ANIMATED_ROWS = 120;
const LANE_X = 13;
const BRACKET_X = 29;

/** How many older commits "Include older commits" adds at a time. */
const OLDER_STEP = 10;

interface PlanRowProps {
  readonly row: PlanRow;
  readonly index: number;
  readonly model?: LogModel;
  readonly color: string;
  readonly step?: RewriteStep;
  /** Why the arrangement cannot be applied, when it is about this commit. */
  readonly problem?: string;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly inFocusedGroup: boolean;
  /** What the row shows as its subject: a new message's first line when reworded. */
  readonly subject: string;
  readonly reworded: boolean;
  /** The subject of the commit it folds into (squash, fixup). */
  readonly intoSubject?: string;
  readonly dragged: boolean;
  readonly dropTarget: boolean;
  /** Glides to a new place (not in long lists: measuring every row would slow each change). */
  readonly animate: boolean;
  /** Starts a possible drag of the row; `click` runs if the press ends without one. */
  readonly onPress: (event: ReactPointerEvent, sha: string, click?: () => void) => void;
}

/** Rows re-render only when what they show changes (long histories stay quick to arrange). */
function samePlanRow(a: PlanRowProps, b: PlanRowProps): boolean {
  return (
    a.row.entry === b.row.entry &&
    a.row.commit === b.row.commit &&
    a.row.role === b.row.role &&
    a.row.bracket === b.row.bracket &&
    // Its group and place are not shown (only whether it is the first row): a commit dropped or
    // moved above it leaves it as it is.
    (a.index === 0) === (b.index === 0) &&
    a.model === b.model &&
    a.color === b.color &&
    a.step?.status === b.step?.status &&
    a.step?.files?.join('\0') === b.step?.files?.join('\0') &&
    a.problem === b.problem &&
    a.selected === b.selected &&
    a.focused === b.focused &&
    a.inFocusedGroup === b.inFocusedGroup &&
    a.subject === b.subject &&
    a.reworded === b.reworded &&
    a.intoSubject === b.intoSubject &&
    a.dragged === b.dragged &&
    a.dropTarget === b.dropTarget &&
    a.animate === b.animate &&
    a.onPress === b.onPress
  );
}

export const PlanRowItem = memo(function PlanRowItem({
  row,
  index,
  model,
  color,
  step,
  problem,
  selected,
  focused,
  inFocusedGroup,
  subject,
  reworded,
  intoSubject,
  dragged,
  dropTarget,
  animate,
  onPress,
}: PlanRowProps) {
  const { entry, commit } = row;
  const refs = model ? (model.refsAt(model.rowOf(entry.sha)) ?? []) : [];
  const label = [
    `${ACTIONS[entry.action].label}: ${subject}${reworded ? ` (was “${commit.subject}”)` : ''}`,
    intoSubject !== undefined ? `folds into “${intoSubject}”` : '',
    `${commit.authorName}, ${relativeTime(commit.authorTime)}`,
    problem ? `can’t apply: ${problem}` : '',
    step?.status === 'conflict' ? 'conflict expected' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <motion.div
      layout={animate ? 'position' : false}
      transition={{ type: 'spring', stiffness: 700, damping: 50 }}
      id={`rewrite-${entry.sha}`}
      data-sha={entry.sha}
      role="option"
      aria-selected={selected}
      aria-label={label}
      className={styles.row}
      data-role={row.role}
      data-action={entry.action}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-group-focus={inFocusedGroup || undefined}
      data-dragged={dragged || undefined}
      data-drop-target={dropTarget || undefined}
      data-problem={problem ? '' : undefined}
      onPointerDown={(event) => {
        // The chip keeps a multiple selection (its menu acts on all of it).
        if ((event.target as HTMLElement).closest('button, [data-chip]')) return;
        if (event.button !== 0) return;
        const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey;
        if (event.shiftKey) select(entry.sha, 'range');
        else if (event.ctrlKey || event.metaKey) select(entry.sha, 'toggle');
        // A press on a selected row keeps the selection, to drag all of it; a click selects one.
        else if (!selected) select(entry.sha, 'single');
        onPress(event, entry.sha, plain && selected ? () => select(entry.sha, 'single') : undefined);
      }}
      onDoubleClick={() => {
        if (row.role === 'head') editMessage(entry.sha);
        else if (row.into) editMessage(row.into);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openActionMenu({ x: event.clientX, y: event.clientY }, entry.sha);
      }}
    >
      <span
        className={styles.handle}
        data-handle
        title="Drag to move (Alt+↑/↓), or onto another commit to fold it in"
      >
        <Icon name="gripper" />
      </span>
      <GraphCell row={row} color={color} first={index === 0} />
      <ActionChip entry={entry} />
      <span className={styles.message}>
        <span className={styles.subject} title={reworded ? `Was: ${commit.subject}` : commit.message}>
          {reworded ? <Icon name="edit" className={styles.reworded} /> : null}
          {subject}
        </span>
        {refs.length > 0 ? <Pills refs={refs} color={color} /> : null}
      </span>
      <span className={styles.author} title={`${commit.authorName} <${commit.authorEmail}>`}>
        <Avatar name={commit.authorName} email={commit.authorEmail} size={16} />
        <span className={styles.authorName}>{commit.authorName}</span>
      </span>
      <span className={styles.date}>{relativeTime(commit.authorTime)}</span>
      <span className={styles.sha}>{shortSha(entry.sha)}</span>
      <StepIcon step={step} problem={problem} dropped={entry.action === 'drop'} />
    </motion.div>
  );
}, samePlanRow);

/** Follows the pointer during a drag, saying what dropping there does. */
export function DragLabel({ drag, session }: { drag: RowDrag; session: RewriteSession }) {
  const ref = useRef<HTMLDivElement>(null);
  // Beside the pointer, and inside the window (placed once its size is known, before it shows).
  useLayoutEffect(() => {
    const label = ref.current;
    if (!label) return;
    const { left, top } = besidePointer(drag, label.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
  });
  const subjectOf = (sha: string) => {
    const subject = session.range.commits.find((commit) => commit.sha === sha)?.subject ?? shortSha(sha);
    return subject.length > 42 ? `${subject.slice(0, 41)}…` : subject;
  };
  const what = drag.shas.length === 1 ? `“${subjectOf(drag.shas[0]!)}”` : `${drag.shas.length} commits`;
  const target = drag.target;
  let icon = 'gripper';
  let text = `Move ${what}`;
  let hint: string | undefined;
  if (target?.kind === 'move') {
    icon = 'arrow-swap';
    text = `Move ${what} here`;
  } else if (target?.kind === 'fold') {
    const squash = target.action === 'squash';
    icon = squash ? 'fold-down' : 'combine';
    text = `${squash ? 'Squash' : 'Fixup'} into “${subjectOf(target.sha)}”`;
    hint = squash ? 'Alt: keep its message (fixup)' : 'Release Alt to combine messages';
  }
  return createPortal(
    <div ref={ref} className={styles.dragLabel} data-kind={target?.kind ?? 'none'} aria-hidden="true">
      <Icon name={icon} />
      <span>{text}</span>
      {hint ? <span className={styles.dragHint}>{hint}</span> : null}
    </div>,
    document.body,
  );
}

function Pills({ refs, color }: { refs: readonly RefInfo[]; color: string }) {
  // Remote branches matter here: they show which commits are already pushed.
  const shown = refs.slice(0, 3);
  const more = refs.length - shown.length;
  return (
    <span className={styles.pills}>
      {shown.map((ref) => (
        <span
          key={ref.name}
          className={[
            styles.pill,
            ref.kind === 'tag' ? styles.pillTag : '',
            ref.kind === 'remote' ? styles.pillRemote : '',
          ].join(' ')}
          style={{ ['--c' as string]: color }}
          title={ref.kind === 'remote' ? `${ref.short} (pushed)` : ref.name}
        >
          <Icon
            name={
              ref.kind === 'tag'
                ? 'tag'
                : ref.kind === 'remote'
                  ? 'cloud'
                  : ref.isHead
                    ? 'check'
                    : 'git-branch'
            }
          />
          {ref.short}
        </span>
      ))}
      {more > 0 ? (
        <span className={styles.pillMore} title={refs.map((r) => r.short).join(', ')}>
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** The lane: kept commits on the main line, folded commits on a bracket joining their result. */
function GraphCell({ row, color, first }: { row: PlanRow; color: string; first: boolean }) {
  const mid = ROW_H / 2;
  const { role, bracket, entry } = row;
  return (
    <svg className={styles.graph} width={BRACKET_X + 9} height={ROW_H} aria-hidden="true">
      <line x1={LANE_X} y1={first ? mid : 0} x2={LANE_X} y2={ROW_H} stroke={color} strokeWidth={2} />
      {bracket === 'start' || bracket === 'member' || bracket === 'through' ? (
        <line
          x1={BRACKET_X}
          y1={bracket === 'start' ? mid : 0}
          x2={BRACKET_X}
          y2={ROW_H}
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.75}
        />
      ) : null}
      {bracket === 'join' ? (
        <path
          d={`M ${BRACKET_X} 0 C ${BRACKET_X} ${mid * 0.9}, ${LANE_X + 9} ${mid}, ${LANE_X + 4} ${mid}`}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.75}
        />
      ) : null}
      {role === 'head' ? (
        <>
          <circle cx={LANE_X} cy={mid} r={7} fill="var(--lf-bg)" />
          <circle
            cx={LANE_X}
            cy={mid}
            r={bracket === 'join' ? 5.5 : 4.5}
            fill={color}
            stroke={bracket === 'join' ? 'var(--lf-bg)' : 'none'}
            strokeWidth={1.5}
          />
          {entry.action === 'edit' ? (
            <rect x={LANE_X - 2} y={mid - 2.5} width={4} height={5} rx={0.5} fill="var(--lf-bg)" />
          ) : null}
          {entry.action === 'split' ? (
            // Cut in two.
            <rect x={LANE_X - 6} y={mid - 0.75} width={12} height={1.5} fill="var(--lf-bg)" />
          ) : null}
        </>
      ) : null}
      {role === 'member' ? (
        <>
          <circle cx={BRACKET_X} cy={mid} r={5.5} fill="var(--lf-bg)" />
          <circle
            cx={BRACKET_X}
            cy={mid}
            r={3.5}
            fill={entry.action === 'squash' ? color : 'var(--lf-bg)'}
            stroke={color}
            strokeWidth={1.5}
          />
        </>
      ) : null}
      {role === 'drop' ? (
        <>
          <circle cx={LANE_X} cy={mid} r={6} fill="var(--lf-bg)" />
          <circle
            cx={LANE_X}
            cy={mid}
            r={4}
            fill="none"
            stroke="var(--lf-fg-muted)"
            strokeWidth={1.25}
            strokeDasharray="2 2"
          />
        </>
      ) : null}
    </svg>
  );
}

/**
 * The action of a commit, and a way to change it with the mouse. Not a button: the row is the
 * listbox option the keyboard is on (its keys, Shift+F10 and the toolbar do the same).
 */
function ActionChip({ entry }: { entry: RewriteEntry }) {
  const info = ACTIONS[entry.action];
  return (
    <span
      className={styles.chip}
      data-chip
      data-action={entry.action}
      title={`${info.hint} — click to change`}
      onClick={(event) => openActionMenu(event.currentTarget, entry.sha)}
    >
      <Icon name={info.icon} />
      {info.label}
      <Icon name="chevron-down" className={styles.chipCaret} />
    </span>
  );
}

function StepIcon({ step, problem, dropped }: { step?: RewriteStep; problem?: string; dropped: boolean }) {
  if (problem)
    return (
      <span className={styles.step} data-status="problem" title={problem}>
        <Icon name="error" />
      </span>
    );
  if (dropped || !step || step.status === 'clean') return <span className={styles.step} />;
  if (step.status === 'conflict')
    return (
      <span
        className={styles.step}
        data-status="conflict"
        title={`Expected conflict in ${step.files?.join(', ')}. Git stops here so you can resolve it.`}
      >
        <Icon name="warning" />
      </span>
    );
  if (step.status === 'empty')
    return (
      <span
        className={styles.step}
        data-status="empty"
        title="Its changes are already there: it becomes an empty commit (kept, so nothing disappears)."
      >
        <Icon name="circle-slash" />
      </span>
    );
  return (
    <span
      className={styles.step}
      data-status="unknown"
      title="Depends on how the conflict above is resolved."
    >
      <Icon name="question" />
    </span>
  );
}

export function BaseRow({
  session,
  color,
  model,
  onInclude,
}: {
  session: RewriteSession;
  color: string;
  model?: LogModel;
  /** Widens the edit to start after `base` instead. */
  onInclude: (base: string | null) => void;
}) {
  const base = session.range.base;
  const meta = base ? (model?.source ?? model)?.metaOf(base) : undefined;
  const subject = meta?.subject;
  const merge = (meta?.parents.length ?? 0) > 1;
  const older = model && !session.applying ? olderBase(model, base, OLDER_STEP) : undefined;
  return (
    <div className={styles.base}>
      <svg className={styles.graph} width={BRACKET_X + 9} height={ROW_H} aria-hidden="true">
        <line
          x1={LANE_X}
          y1={0}
          x2={LANE_X}
          y2={ROW_H / 2}
          stroke={color}
          strokeWidth={2}
          strokeOpacity={0.5}
        />
        <circle cx={LANE_X} cy={ROW_H / 2} r={4} fill="var(--lf-bg)" stroke={color} strokeWidth={1.5} />
      </svg>
      <span className={styles.baseText}>
        {base ? (
          <>
            Starts after <code>{shortSha(base)}</code>{' '}
            {subject ? <span className={styles.baseSubject}>{subject}</span> : null}{' '}
            <span className={styles.unchanged}>
              — {merge ? 'a merge: editing cannot reach past it' : 'stays as it is'}
            </span>
          </>
        ) : (
          'Starts at the very first commit'
        )}
      </span>
      {older && base ? (
        <button
          type="button"
          className={styles.textButton}
          title={
            older.added === 1
              ? `Add ${shortSha(base)} to the edit. It stays as it is unless you change it.`
              : 'Add older commits to the edit. They stay as they are unless you change them.'
          }
          onClick={() => onInclude(older.base)}
        >
          <Icon name="add" />
          {older.added === 1 ? `Include ${shortSha(base)}` : `Include ${older.added} older commits`}
        </button>
      ) : null}
    </div>
  );
}

/** How to arrange with the mouse, under the list (the toolbar's tooltips name the keys). */
export function DragHint() {
  return (
    <p className={styles.listHint}>
      <Icon name="gripper" />
      <span>
        Drag to reorder, or drop onto a commit to squash into it (<kbd>Alt</kbd>: fixup).
      </span>
    </p>
  );
}
