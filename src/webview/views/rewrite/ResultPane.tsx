/*
 * The right side of the history editor: the commits the edit produces (with their messages)
 * and the exact git commands and todo.
 */

import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useRef, useState } from 'react';
import { displayRev } from '../../../shared/oid';
import type { RewriteStep } from '../../../shared/rewrite';
import { formatCommand } from '../../../shared/shell';
import { CommandLine } from '../../components/CommandLine';
import { Icon } from '../../components/Icon';
import { relativeTime, shortSha } from '../../graph/format';
import { copyText } from '../../state/queries';
import {
  editMessage,
  resetGroupMessage,
  select,
  setGroupMessage,
  type ResultCommit,
  type RewriteSession,
} from '../../state/rewrite';
import { Avatar } from '../log/parts';
import type { Problem } from './EditorBars';
import styles from './HistoryEditor.module.css';

export function ResultPane({
  session,
  results,
  steps,
  color,
  focusedGroup,
  problem,
  pane,
  onPane,
}: {
  session: RewriteSession;
  results: readonly ResultCommit[];
  steps: ReadonlyMap<string, RewriteStep>;
  color: string;
  focusedGroup?: number;
  /** Why the arrangement cannot be applied (its commit's card says so too). */
  problem?: Problem;
  pane: 'result' | 'git';
  onPane: (pane: 'result' | 'git') => void;
}) {
  return (
    <aside className={styles.resultPane} aria-label={pane === 'result' ? 'Result' : 'Git commands'}>
      <div className={styles.paneTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'result'}
          className={styles.paneTab}
          onClick={() => onPane('result')}
        >
          Result <span className={styles.badge}>{results.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'git'}
          className={styles.paneTab}
          onClick={() => onPane('git')}
        >
          Git commands
        </button>
      </div>
      {pane === 'git' ? (
        <GitPane session={session} />
      ) : (
        <div className={styles.results}>
          <AnimatePresence initial={false}>
            {results.map((result, position) => (
              <ResultCard
                key={result.head.sha}
                result={result}
                editing={session.editing === result.head.sha}
                applying={session.applying}
                // Cards glide to their new places, unless there are so many that measuring them
                // all would slow every change down.
                animate={results.length <= ANIMATED_CARDS}
                color={color}
                // The branch ends up at the newest commit of the result.
                branch={position === 0 ? session.range.branch : undefined}
                focused={result.index === focusedGroup}
                conflict={result.commits
                  .map((commit) => steps.get(commit.sha))
                  .find((step) => step?.status === 'conflict')}
                problem={
                  problem?.sha && result.commits.some((commit) => commit.sha === problem.sha)
                    ? problem.message
                    : undefined
                }
              />
            ))}
          </AnimatePresence>
          {results.length === 0 ? (
            <div className={styles.empty}>
              {session.range.onto
                ? `Every commit is dropped: ${session.range.branch ?? 'HEAD'} moves to ${displayRev(session.range.onto.rev)}.`
                : session.range.base
                  ? `Every commit is dropped: ${session.range.branch ?? 'HEAD'} goes back to ${shortSha(session.range.base)}.`
                  : 'Every commit is dropped.'}
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

/** Beyond this many result cards they no longer glide (measuring them all slows changes down). */
const ANIMATED_CARDS = 120;

interface ResultCardProps {
  readonly result: ResultCommit;
  /** Its message editor is open. */
  readonly editing: boolean;
  readonly applying: boolean;
  readonly animate: boolean;
  readonly color: string;
  readonly branch?: string;
  readonly focused: boolean;
  readonly conflict?: RewriteStep;
  readonly problem?: string;
}

/** Cards re-render only when what they show changes (long histories stay quick to arrange). */
function sameCard(a: ResultCardProps, b: ResultCardProps): boolean {
  const x = a.result;
  const y = b.result;
  return (
    x.head === y.head &&
    x.commits.length === y.commits.length &&
    x.commits.every((commit, i) => commit === y.commits[i]) &&
    x.message === y.message &&
    x.draft === y.draft &&
    x.newMessage === y.newMessage &&
    x.customMessage === y.customMessage &&
    x.edit === y.edit &&
    x.split === y.split &&
    a.editing === b.editing &&
    a.applying === b.applying &&
    a.animate === b.animate &&
    a.color === b.color &&
    a.branch === b.branch &&
    a.focused === b.focused &&
    a.conflict?.status === b.conflict?.status &&
    a.conflict?.files?.join('\0') === b.conflict?.files?.join('\0') &&
    a.problem === b.problem
  );
}

const ResultCard = memo(function ResultCard({
  result,
  editing,
  applying,
  animate,
  color,
  branch,
  focused,
  conflict,
  problem,
}: ResultCardProps) {
  const head = result.commits[0]!;
  const [subject, ...bodyLines] = result.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const squashed = result.commits.length - 1;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, textarea.value.split('\n', 1)[0]!.length);
    // In a short panel the card opens below the fold: bring the whole editor, its buttons
    // included, into view once laid out (the pane scrolls, the page never does).
    const frame = requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  return (
    <motion.div
      layout={animate}
      className={styles.card}
      data-focused={focused || undefined}
      data-problem={problem ? '' : undefined}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 520, damping: 42 }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('textarea, button')) return;
        select(result.head.sha);
      }}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardDot} style={{ background: color }} />
        <span className={styles.cardSubject} title={subject}>
          {subject || <em>No message</em>}
        </span>
        {branch ? (
          <span
            className={styles.cardBranch}
            style={{ ['--c' as string]: color }}
            title={`${branch} ends up here`}
          >
            <Icon name="git-branch" />
            {branch}
          </span>
        ) : null}
        {problem ? (
          <Icon name="error" className={styles.cardProblem} title={problem} />
        ) : conflict ? (
          <Icon
            name="warning"
            className={styles.cardConflict}
            title={`Conflict expected: ${conflict.files?.join(', ')}`}
          />
        ) : null}
      </div>
      <div className={styles.cardMeta}>
        <Avatar name={head.authorName} email={head.authorEmail} size={14} />
        <span>{head.authorName}</span>
        <span className={styles.dot}>·</span>
        <span>{relativeTime(head.authorTime)}</span>
        {squashed > 0 ? <span className={styles.tag}>{squashed + 1} commits</span> : null}
        {result.newMessage ? <span className={styles.tag}>new message</span> : null}
        {result.edit ? <span className={styles.tagWarn}>stops to edit</span> : null}
        {result.split ? (
          <span
            className={styles.tagSplit}
            title="Git stops with its changes uncommitted: commit them in parts"
          >
            splits into parts
          </span>
        ) : null}
      </div>
      {focused && !editing && body ? <pre className={styles.cardBody}>{body}</pre> : null}
      {editing ? (
        <div className={styles.editor} ref={editorRef}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={result.draft}
            rows={Math.min(12, Math.max(3, result.draft.split('\n').length + 1))}
            spellCheck
            // Once Apply is pressed the message is what gets applied.
            readOnly={applying}
            aria-label="Commit message"
            onChange={(event) => setGroupMessage(result.head.sha, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                editMessage(undefined);
                (document.querySelector(`.${styles.rows}`) as HTMLElement | null)?.focus();
              }
              // Ctrl+Enter bubbles up to the editor, which applies.
            }}
          />
          <div className={styles.editorActions}>
            {squashed > 0 && result.customMessage ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={() => resetGroupMessage(result.head.sha)}
              >
                Combine the messages again
              </button>
            ) : null}
            {squashed === 0 && result.newMessage ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={() => resetGroupMessage(result.head.sha)}
              >
                Original message
              </button>
            ) : null}
            <span className={styles.spacer} />
            <button type="button" className={styles.textButton} onClick={() => editMessage(undefined)}>
              Done
            </button>
          </div>
        </div>
      ) : focused && result.split ? (
        <p className={styles.cardNote}>
          Its parts get their messages as you commit them; what is left keeps this one.
        </p>
      ) : focused ? (
        <button type="button" className={styles.editMessage} onClick={() => editMessage(result.head.sha)}>
          <Icon name="edit" /> Edit message
        </button>
      ) : null}
    </motion.div>
  );
}, sameCard);

/** Abbreviates the object IDs of a todo for display (copying gives the full todo). */
function shortTodo(todo: string): string {
  return todo.replace(/\b([0-9a-f]{12})[0-9a-f]{28,52}\b/g, '$1');
}

function GitPane({ session }: { session: RewriteSession }) {
  const plan = session.plan;
  const [copied, setCopied] = useState(false);
  const text = plan
    ? `${plan.commands.map((command) => formatCommand(command.args)).join('\n')}\n\n# todo\n${plan.rewrite?.todo ?? ''}`
    : '';
  return (
    <div className={styles.git}>
      <div className={styles.gitHead}>
        <span className={styles.gitHint}>
          New messages ride in empty commits folded in with <code>fixup -C</code>: git never opens an editor,
          and continuing after a stop works the same from a terminal.
          {plan?.rewrite?.splits ? (
            <>
              {' '}
              A commit to split is an <code>edit</code> stop where Lanefold takes it apart (
              <code>git reset HEAD~1</code>); Continue commits what is left with <code>commit -C</code>.
            </>
          ) : null}
        </span>
        <button
          type="button"
          className={styles.textButton}
          disabled={!plan}
          onClick={() =>
            void copyText(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {plan ? (
        <>
          <ol className={styles.commands}>
            {plan.commands.map((command, index) => (
              <li key={index}>
                <div className={styles.commandLine}>
                  <span className={styles.prompt}>$</span>
                  <CommandLine args={command.args} wrap />
                </div>
                <p className={styles.explanation}>{command.explanation}</p>
                {command.flags.length > 0 ? (
                  <dl className={styles.flags}>
                    {command.flags.map((flag) => (
                      <div key={flag.flag}>
                        <dt>
                          <code>{flag.flag}</code>
                        </dt>
                        <dd>{flag.meaning}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ol>
          <div className={styles.todo}>
            <div className={styles.todoTitle}>The todo git follows</div>
            <pre title={plan.rewrite?.todo}>{shortTodo(plan.rewrite?.todo ?? '')}</pre>
          </div>
        </>
      ) : (
        <div className={styles.empty}>Planning…</div>
      )}
    </div>
  );
}
