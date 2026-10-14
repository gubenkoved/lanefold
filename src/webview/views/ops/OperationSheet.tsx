import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  MergeStrategy,
  Operation,
  OperationPlan,
  PlanNotice,
  PullMode,
  ResetMode,
} from '../../../shared/operations';
import { formatCommand } from '../../../shared/shell';
import { CommandLine } from '../../components/CommandLine';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/Segmented';
import { closeSheet, confirmSheet, editSheet, runOperation, useOperations } from '../../state/operations';
import { copyText } from '../../state/queries';
import { addRemote } from '../../state/remotes';
import { folderFromUrl, openLinkedRepository } from '../log/submodules';
import styles from './OperationSheet.module.css';

const RESET_MODES: { value: ResetMode; label: string; detail: string }[] = [
  {
    value: 'soft',
    label: 'Soft',
    detail: 'Keep everything; the changes of the commits left behind become staged.',
  },
  { value: 'mixed', label: 'Mixed', detail: 'Keep your files; those changes become unstaged.' },
  {
    value: 'keep',
    label: 'Keep',
    detail: 'Update files to the target, but stop rather than overwrite local changes.',
  },
  {
    value: 'hard',
    label: 'Hard',
    detail:
      'Make everything match the target. Uncommitted changes are discarded (a snapshot is kept for Undo).',
  },
];

const MERGE_STRATEGIES: { value: MergeStrategy; label: string; detail: string }[] = [
  { value: 'auto', label: 'Default', detail: 'Fast-forward when possible, otherwise create a merge commit.' },
  {
    value: 'no-ff',
    label: 'Merge commit',
    detail: 'Always record a merge commit, keeping the branch visible in history.',
  },
  {
    value: 'ff-only',
    label: 'Fast-forward',
    detail: 'Only move the branch forward; stop if the histories diverged.',
  },
  {
    value: 'squash',
    label: 'Squash',
    detail: 'Combine all incoming changes into one new commit (no merge recorded).',
  },
];

const PULL_MODES: { value: PullMode; label: string; detail: string }[] = [
  {
    value: 'rebase',
    label: 'Rebase',
    detail: 'Replay your local commits on top of the incoming ones: a straight history, no merge commit.',
  },
  {
    value: 'merge',
    label: 'Merge',
    detail: 'Join both lines of work with a merge commit; your commits keep their hashes.',
  },
  {
    value: 'ff-only',
    label: 'Fast-forward only',
    detail: 'Only move forward to the incoming commits; stop if your branch has its own.',
  },
];

type PatchMode = 'changes' | 'commits';
const PATCH_MODES: { value: PatchMode; label: string; detail: string }[] = [
  {
    value: 'changes',
    label: 'Apply the changes',
    detail: 'Change the files (working tree and index); you commit when ready.',
  },
  {
    value: 'commits',
    label: 'Recreate the commits',
    detail: 'Commit each patch in the file on the current branch, with its message and author (git am).',
  },
];

type StashScope = 'all' | 'staged';
const STASH_SCOPES: { value: StashScope; label: string; detail: string }[] = [
  {
    value: 'all',
    label: 'All changes',
    detail: 'Staged and unstaged changes; the working tree goes back to HEAD.',
  },
  { value: 'staged', label: 'Staged only', detail: 'Only what is staged; everything else stays as it is.' },
];

/** What a plan says about a field: why its value will not do (or, on an untouched form, what it needs). */
interface FieldError {
  /** The message’s element (the field is described by it). */
  readonly id: string;
  readonly text: string;
  /** Only what is missing, on a form not filled in yet: a hint, not an error. */
  readonly soft: boolean;
}

type FieldErrors = Readonly<Record<string, FieldError>>;

/** The text fields a form shows, by the names plan notices use for them. */
function fieldNames(operation: Operation): readonly string[] {
  switch (operation.kind) {
    case 'createBranch':
    case 'createTag':
      return ['name'];
    case 'setIdentity':
      return ['name', 'email'];
    case 'renameBranch':
    case 'renameRemote':
      return ['to'];
    case 'addWorktree':
      return operation.newBranch !== undefined ? ['path', 'newBranch'] : ['path'];
    case 'addSubmodule':
      return ['url', 'path', 'branch'];
    case 'bisectStart':
      return ['bad', 'good'];
    case 'addRemote':
      return ['name', 'url'];
    case 'setRemoteUrl':
      return ['url'];
    default:
      return [];
  }
}

/** One of a few choices (a radio group: arrow keys move the choice), with what it means below. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; detail: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id={`${id}-label`}>
        {label}
      </span>
      <Segmented
        label={label}
        labelledBy={`${id}-label`}
        describedBy={`${id}-hint`}
        value={value}
        options={options}
        onChange={onChange}
        className={styles.segmented}
      />
      <span className={styles.hint} id={`${id}-hint`}>
        {options.find((o) => o.value === value)?.detail}
      </span>
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
  multiline,
  autoFocus,
  hint,
  error,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  autoFocus?: boolean;
  hint?: string;
  error?: FieldError;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [error?.id, hintId].filter(Boolean).join(' ') || undefined;
  // Missing input on a form not filled in yet is no error (yet).
  const invalid = error && !error.soft ? true : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={styles.input}
          rows={3}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          spellCheck
        />
      ) : (
        <input
          id={id}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          spellCheck={false}
          autoFocus={autoFocus}
          data-submit
        />
      )}
      {error ? (
        <span id={error.id} className={styles.fieldError} data-soft={error.soft || undefined}>
          <Icon name={error.soft ? 'info' : 'error'} />
          <span>{error.text}</span>
        </span>
      ) : null}
      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={styles.checkbox}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Uncommitted changes in the way, offered to be set aside and brought back after (`what` does). */
function CarryOver({
  operation,
  plan,
  what,
}: {
  operation: Extract<Operation, { kind: 'checkout' | 'revert' | 'cherryPick' }>;
  plan: OperationPlan | undefined;
  what: string;
}) {
  // Only when uncommitted changes are in the way (or were asked to be carried).
  return plan?.carryOver || operation.carry ? (
    <Checkbox
      label={`Carry my uncommitted changes over (stash them, ${what}, then restore them)`}
      checked={!!operation.carry}
      onChange={(carry) => editSheet({ ...operation, carry })}
    />
  ) : null;
}

/** Inputs for operations that need them; every change re-plans. */
function Fields({
  operation,
  plan,
  errors,
}: {
  operation: Operation;
  plan: OperationPlan | undefined;
  errors: FieldErrors;
}) {
  switch (operation.kind) {
    case 'checkout':
      return <CarryOver operation={operation} plan={plan} what="switch" />;
    case 'deleteBranch':
      // Only for a branch with an upstream on a remote (or when it was asked for).
      return plan?.remoteBranch || operation.remote ? (
        <Checkbox
          label={`Also delete ${plan?.remoteBranch ?? 'its upstream'} from the remote (Undo cannot bring that back)`}
          checked={!!operation.remote}
          onChange={(remote) => editSheet({ ...operation, remote })}
        />
      ) : null;
    case 'createBranch':
      return (
        <>
          <TextField
            label="Branch name"
            value={operation.name}
            placeholder="feature/my-change"
            autoFocus
            error={errors.name}
            onChange={(name) =>
              editSheet({ ...operation, name: name.trim() === name ? name : name.replace(/\s/g, '-') })
            }
          />
          <Checkbox
            label="Switch to the new branch"
            checked={!!operation.checkout}
            onChange={(checkout) => editSheet({ ...operation, checkout })}
          />
        </>
      );
    case 'setIdentity':
      return (
        <>
          <TextField
            label="Name"
            value={operation.name}
            placeholder="Ada Lovelace"
            autoFocus
            error={errors.name}
            onChange={(name) => editSheet({ ...operation, name })}
          />
          <TextField
            label="Email"
            value={operation.email}
            placeholder="ada@example.com"
            error={errors.email}
            onChange={(email) => editSheet({ ...operation, email })}
          />
          <Checkbox
            label="Use them in every repository on this computer"
            checked={operation.global}
            onChange={(global) => editSheet({ ...operation, global })}
          />
        </>
      );
    case 'createTag':
      return (
        <>
          <TextField
            label="Tag name"
            value={operation.name}
            placeholder="v1.2.0"
            autoFocus
            error={errors.name}
            onChange={(name) => editSheet({ ...operation, name })}
          />
          <TextField
            label="Message"
            value={operation.message ?? ''}
            placeholder="Optional — a message makes it an annotated tag"
            multiline
            onChange={(message) => editSheet({ ...operation, message })}
          />
        </>
      );
    case 'renameBranch':
      return (
        <>
          <TextField
            label="New name"
            value={operation.to}
            autoFocus
            error={errors.to}
            onChange={(to) => editSheet({ ...operation, to })}
          />
          {/* Only for a branch with an upstream on a remote (or when it was asked for). */}
          {plan?.remoteBranch || operation.remote ? (
            <Checkbox
              label={`Also rename it on ${plan?.upstreamRemote ?? 'its remote'} (Undo cannot take that back)`}
              checked={!!operation.remote}
              onChange={(remote) => editSheet({ ...operation, remote })}
            />
          ) : null}
        </>
      );
    case 'reset':
      return (
        <Choice
          label="Mode"
          value={operation.mode}
          options={RESET_MODES}
          onChange={(mode) => editSheet({ ...operation, mode })}
        />
      );
    case 'merge':
      return (
        <>
          <Choice
            label="How"
            value={operation.strategy}
            options={MERGE_STRATEGIES}
            onChange={(strategy) => editSheet({ ...operation, strategy })}
          />
          {operation.strategy !== 'ff-only' ? (
            <TextField
              label={operation.strategy === 'squash' ? 'Commit message' : 'Merge message'}
              value={operation.message ?? ''}
              placeholder="Optional — leave empty for git’s default message"
              onChange={(message) => editSheet({ ...operation, message })}
            />
          ) : null}
        </>
      );
    case 'pull':
      return (
        <Choice
          label="How"
          value={operation.mode}
          options={PULL_MODES}
          onChange={(mode) => editSheet({ ...operation, mode })}
        />
      );
    case 'push':
      return (
        <>
          <Checkbox
            label="Force push, with lease (only if the remote is still as last fetched)"
            checked={!!operation.force}
            onChange={(force) => editSheet({ ...operation, force })}
          />
          <Checkbox
            label="Also push annotated tags on these commits"
            checked={!!operation.tags}
            onChange={(tags) => editSheet({ ...operation, tags })}
          />
        </>
      );
    case 'stashPush':
      return (
        <>
          <TextField
            label="Message"
            value={operation.message ?? ''}
            placeholder="Optional — what you were working on"
            autoFocus
            onChange={(message) => editSheet({ ...operation, message })}
          />
          {operation.paths?.length ? null : (
            <Choice
              label="What"
              value={operation.stagedOnly ? 'staged' : 'all'}
              options={STASH_SCOPES}
              onChange={(scope) =>
                editSheet(
                  scope === 'staged'
                    ? { ...operation, stagedOnly: true, includeUntracked: false, keepIndex: false }
                    : { ...operation, stagedOnly: false },
                )
              }
            />
          )}
          {operation.stagedOnly ? null : (
            <>
              <Checkbox
                label="Include untracked files"
                checked={!!operation.includeUntracked}
                onChange={(includeUntracked) => editSheet({ ...operation, includeUntracked })}
              />
              <Checkbox
                label="Keep the staged changes in place (they are stashed too)"
                checked={!!operation.keepIndex}
                onChange={(keepIndex) => editSheet({ ...operation, keepIndex })}
              />
            </>
          )}
        </>
      );
    case 'applyPatch':
      return (
        <Choice
          label="How"
          value={operation.commit ? 'commits' : 'changes'}
          options={PATCH_MODES}
          onChange={(mode) => editSheet({ ...operation, commit: mode === 'commits' })}
        />
      );
    case 'addWorktree':
      return (
        <>
          <TextField
            label="Folder"
            value={operation.path}
            placeholder="Where to check it out (a new or empty folder)"
            autoFocus
            error={errors.path}
            onChange={(path) => editSheet({ ...operation, path })}
            hint="A relative path is taken from the repository’s folder."
          />
          {operation.newBranch !== undefined ? (
            <TextField
              label="New branch"
              value={operation.newBranch}
              placeholder="feature/my-change"
              error={errors.newBranch}
              onChange={(newBranch) => editSheet({ ...operation, newBranch: newBranch.replace(/\s/g, '-') })}
            />
          ) : null}
        </>
      );
    case 'addSubmodule':
      return (
        <>
          <TextField
            label="Repository URL"
            value={operation.url}
            placeholder="https://example.com/team/library.git"
            autoFocus
            error={errors.url}
            // The folder follows the URL until it is edited.
            onChange={(url) =>
              editSheet({
                ...operation,
                url,
                path: operation.path === folderFromUrl(operation.url) ? folderFromUrl(url) : operation.path,
              })
            }
          />
          <TextField
            label="Folder"
            value={operation.path}
            placeholder="Where to put it (a new or empty folder)"
            error={errors.path}
            onChange={(path) => editSheet({ ...operation, path })}
            hint="Inside this repository; a relative path is taken from its folder."
          />
          <TextField
            label="Branch"
            value={operation.branch ?? ''}
            placeholder="Optional — a branch for it to follow"
            error={errors.branch}
            onChange={(branch) => editSheet({ ...operation, branch: branch.trim() })}
          />
        </>
      );
    case 'updateSubmodules':
      return (
        <Checkbox
          label={`Also update the submodules inside ${operation.paths?.length === 1 ? 'it' : 'them'}`}
          checked={!!operation.recursive}
          onChange={(recursive) => editSheet({ ...operation, recursive })}
        />
      );
    case 'bisectStart':
      return (
        <>
          <TextField
            label="Has the problem (bad)"
            value={operation.bad}
            placeholder="A commit, branch or tag"
            error={errors.bad}
            onChange={(bad) => editSheet({ ...operation, bad: bad.trim() })}
          />
          <TextField
            label="Does not have it (good)"
            value={operation.good.join(' ')}
            placeholder="An older commit, branch or tag (several: separate with spaces)"
            autoFocus={operation.good.length === 0}
            error={errors.good}
            onChange={(good) => editSheet({ ...operation, good: good.split(/\s+/).filter(Boolean) })}
          />
        </>
      );
    case 'revert':
      return <CarryOver operation={operation} plan={plan} what="revert" />;
    case 'cherryPick':
      return (
        <>
          <Checkbox
            label="Add “(cherry picked from commit …)” to the messages"
            checked={!!operation.recordOrigin}
            onChange={(recordOrigin) => editSheet({ ...operation, recordOrigin })}
          />
          <CarryOver operation={operation} plan={plan} what="cherry-pick" />
        </>
      );
    case 'addRemote':
      return (
        <>
          <TextField
            label="Name"
            value={operation.name}
            placeholder="origin"
            autoFocus={!operation.name}
            error={errors.name}
            onChange={(name) => editSheet({ ...operation, name: name.replace(/\s/g, '-') })}
          />
          <TextField
            label="URL"
            value={operation.url}
            placeholder="https://github.com/you/project.git"
            autoFocus={!!operation.name}
            hint="https://, ssh (git@host:path) or a folder on this computer."
            error={errors.url}
            onChange={(url) => editSheet({ ...operation, url })}
          />
          <Checkbox
            label="Fetch its branches right away"
            checked={!!operation.fetch}
            onChange={(fetch) => editSheet({ ...operation, fetch })}
          />
        </>
      );
    case 'renameRemote':
      return (
        <TextField
          label="New name"
          value={operation.to}
          autoFocus
          error={errors.to}
          onChange={(to) => editSheet({ ...operation, to: to.replace(/\s/g, '-') })}
        />
      );
    case 'setRemoteUrl':
      return (
        <>
          <TextField
            label={operation.push ? 'Push URL' : 'URL'}
            value={operation.url}
            placeholder="https://github.com/you/project.git"
            autoFocus
            error={errors.url}
            onChange={(url) => editSheet({ ...operation, url })}
          />
          <Checkbox
            label="Only where pushes go (fetching keeps its URL)"
            checked={!!operation.push}
            onChange={(push) => editSheet({ ...operation, push })}
          />
        </>
      );
    default:
      return null;
  }
}

const NOTICE_ICONS = { info: 'info', warning: 'warning', danger: 'error' } as const;
const short = (value: string | undefined) =>
  value && /^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, 8) : value;

/** A ref as the sheet names it: “main”, “v1.0”, “origin/main”, with its kind’s icon. */
function refLabel(ref: string): { name: string; icon: string } {
  if (ref === 'HEAD') return { name: ref, icon: 'target' };
  if (ref.startsWith('refs/tags/')) return { name: ref.slice('refs/tags/'.length), icon: 'tag' };
  if (ref.startsWith('refs/remotes/')) return { name: ref.slice('refs/remotes/'.length), icon: 'cloud' };
  return { name: ref.replace(/^refs\/heads\//, ''), icon: 'git-branch' };
}

function Effects({ plan }: { plan: OperationPlan }) {
  if (plan.changes.length === 0 && !plan.conflicts?.predicted) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>What changes</h3>
      <ul className={styles.changes}>
        {plan.changes.map((change) => {
          const { name, icon } = refLabel(change.ref);
          return (
            <li key={`${change.ref}:${change.from}:${change.to}`}>
              <Icon name={icon} />
              <span className={styles.refName}>{name}</span>
              {change.toNew ? (
                <>
                  <code>{short(change.from)}</code>
                  <Icon name="arrow-right" className={styles.arrow} />
                  <span className={styles.created}>{change.toNew}</span>
                </>
              ) : change.from === undefined ? (
                <span className={styles.created}>new{change.to ? ` at ${short(change.to)}` : ''}</span>
              ) : change.to === undefined ? (
                <span className={styles.deleted}>deleted (was {short(change.from)})</span>
              ) : (
                <>
                  <code>{short(change.from)}</code>
                  <Icon name="arrow-right" className={styles.arrow} />
                  <code>{short(change.to)}</code>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {plan.conflicts?.predicted ? (
        <div className={styles.conflicts}>
          <Icon name="warning" />
          <span>
            Predicted conflicts:{' '}
            {plan.conflicts.files.slice(0, 6).map((file) => (
              <code key={file}>{file}</code>
            ))}
            {plan.conflicts.files.length > 6 ? ` +${plan.conflicts.files.length - 6} more` : ''}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function Commands({ plan, dimmed }: { plan: OperationPlan; dimmed: boolean }) {
  const [copied, setCopied] = useState(false);
  if (plan.commands.length === 0) return null;
  // One line per command; a piped command continues the line before it.
  const text = plan.commands
    .reduce<string[]>((lines, command) => {
      const formatted = formatCommand(command.args);
      if (command.pipe && lines.length > 0) lines[lines.length - 1] += ` | ${formatted}`;
      else lines.push(formatted);
      return lines;
    }, [])
    .join('\n');
  return (
    // Faded while it cannot run: what would run, not what will.
    <section className={styles.section} data-dimmed={dimmed || undefined}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Git commands</h3>
        <button
          type="button"
          className={styles.copy}
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
      <ol className={styles.commands}>
        {plan.commands.map((command, index) => (
          <li key={index} className={styles.command}>
            <div className={styles.commandLine}>
              <span
                className={styles.prompt}
                title={command.pipe ? 'Reads the output of the command above' : undefined}
              >
                {command.pipe ? '|' : '$'}
              </span>
              <CommandLine args={command.args} wrap placeholders />
            </div>
            <p className={styles.explanation}>{command.explanation}</p>
            {command.flags.length > 0 ? (
              <dl className={styles.flags}>
                {command.flags.map((flag) => (
                  <div key={flag.flag} className={styles.flag}>
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
    </section>
  );
}

/** Review sheet: inputs, effects, warnings and the exact commands, before anything runs. */
export function OperationSheet() {
  const sheet = useOperations((state) => state.sheet);
  const dialogRef = useRef<HTMLDivElement>(null);
  const noticeId = useId();
  const plan = sheet?.plan;
  /** A form not filled in yet (and not asked to run): what it still needs is a hint, not an error. */
  const pristine = !!sheet?.form && !sheet.edited && !sheet.attempts;
  const soft = (notice: PlanNotice) => pristine && !!notice.missing && notice.level === 'danger';
  // What the plan says about the form's fields shows at the field (and describes it).
  const shownFields = sheet ? fieldNames(sheet.operation) : [];
  const errors: Record<string, FieldError> = {};
  plan?.notices.forEach((notice, index) => {
    if (notice.field && shownFields.includes(notice.field) && !errors[notice.field])
      errors[notice.field] = { id: `${noticeId}-${index}`, text: notice.text, soft: soft(notice) };
  });
  const listed = plan?.notices.filter((notice) => !notice.field || !shownFields.includes(notice.field)) ?? [];
  // Blocked for real (not just waiting for input): it reads as such, and says nothing will happen.
  // (The plan on screen counts: while the next one is coming, the sheet does not flicker.)
  const blocked = !!plan?.blocked && plan.notices.some((n) => n.level === 'danger' && !soft(n));
  // A block that no field explains: the run button says so instead of naming the action.
  const notPossible =
    blocked &&
    !sheet?.busy &&
    plan.notices.some((n) => n.level === 'danger' && !(n.field && shownFields.includes(n.field)));
  /** Read out once (politely) when it changes: why it cannot run, or that it was not run yet. */
  const announcement = sheet?.held
    ? 'Not run yet: look over what changed, then run it.'
    : blocked
      ? (plan.notices.find((n) => n.level === 'danger')?.text ?? '')
      : '';

  useEffect(() => {
    if (!sheet) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Enter that confirms an input method's word (Japanese, Chinese…) is not a submit.
      if (event.isComposing || event.keyCode === 229) return;
      const dialog = dialogRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSheet();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void confirmSheet();
      } else if (event.key === 'Enter' && (event.target as HTMLElement).dataset?.submit !== undefined) {
        event.preventDefault();
        void confirmSheet();
      } else if (event.key === 'Tab' && dialog) {
        // A modal keeps focus inside: Tab wraps around its controls.
        const focusable = [
          ...dialog.querySelectorAll<HTMLElement>(
            'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]',
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        const inside = !!active && dialog.contains(active);
        if (!inside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sheet]);

  // Focus goes into the sheet when it opens (its first field, else Run once the plan is there,
  // else Cancel when nothing can run, else the sheet itself), and back where it was when it closes.
  const open = !!sheet;
  const ready = !!plan && !sheet?.busy;
  const returnFocus = useRef<HTMLElement | null>(null);
  // What had focus last outside the sheet: a field can take focus as the sheet mounts, before
  // the effect below runs (and before the sheet's ref is set).
  const outside = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !event.target.closest('[data-operation-sheet]'))
        outside.current = event.target;
    };
    window.addEventListener('focusin', onFocusIn);
    return () => window.removeEventListener('focusin', onFocusIn);
  }, []);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocus.current =
      active instanceof HTMLElement && !active.closest('[data-operation-sheet]') ? active : outside.current;
    return () => {
      const target = returnFocus.current;
      const active = document.activeElement;
      // Still in the sheet while it animates away: it goes back too (else it ends up nowhere).
      const leaving = !!active?.closest('[data-operation-sheet]');
      if (target?.isConnected && (!active || active === document.body || leaving))
        target.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const element = dialogRef.current;
    if (!element) return;
    const active = document.activeElement;
    if (active && element.contains(active) && active !== element) return;
    const target =
      element.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ??
      element.querySelector<HTMLElement>('[data-primary]:not([disabled])') ??
      (ready ? element.querySelector<HTMLElement>('[data-cancel]') : null) ??
      element;
    target.focus({ preventScroll: true });
  }, [open, ready]);
  // Asked to run what cannot run: the field that is wrong gets focus, to be put right.
  const attempts = sheet?.attempts ?? 0;
  useEffect(() => {
    if (attempts === 0) return;
    const invalid = dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid && document.activeElement !== invalid) invalid.focus();
  }, [attempts]);

  return (
    <AnimatePresence>
      {sheet ? (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeSheet();
          }}
        >
          <motion.div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={plan?.title ?? 'Operation'}
            data-operation-sheet
            tabIndex={-1}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 40 }}
          >
            <header className={styles.header}>
              <div className={styles.titleRow}>
                <h2 className={styles.title}>{plan?.title ?? 'Preparing…'}</h2>
                {plan?.destructive ? (
                  <span className={styles.badge}>{plan.risk ?? 'Rewrites or discards'}</span>
                ) : null}
                {sheet.busy ? <Icon name="loading" spin className={styles.spinner} /> : null}
              </div>
              {plan?.summary ? (
                <p className={styles.summary} data-dimmed={blocked || undefined}>
                  {plan.summary}
                </p>
              ) : null}
            </header>
            <div className={styles.body} data-busy={sheet.busy}>
              {/* Nothing in the form changes a plan that cannot run at all. */}
              <fieldset className={styles.fields} disabled={!!plan?.impossible}>
                <Fields operation={sheet.operation} plan={plan} errors={errors} />
              </fieldset>
              {listed.length > 0 ? (
                <ul className={styles.notices}>
                  {listed.map((notice, index) => {
                    // A form nobody has filled in yet is not wrong: what it lacks reads as a hint.
                    const level = soft(notice) ? 'info' : notice.level;
                    return (
                      <li key={index} className={styles.notice} data-level={level}>
                        <Icon name={NOTICE_ICONS[level]} />
                        <span>{notice.text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {plan?.needsRemote ? (
                <div className={styles.remedy}>
                  <button
                    type="button"
                    onClick={() => {
                      const operation = sheet.operation;
                      addRemote([], {
                        // Then back to what needed it, with the remote in place.
                        onDone: (result) => {
                          if (result.status === 'done') void runOperation(operation, { review: true });
                        },
                      });
                    }}
                  >
                    <Icon name="add" /> Add remote…
                  </button>
                </div>
              ) : null}
              {plan?.worktree ? (
                <div className={styles.remedy}>
                  <button
                    type="button"
                    title={plan.worktree}
                    onClick={() => {
                      const { repoId } = sheet;
                      const folder = plan.worktree!;
                      closeSheet();
                      void openLinkedRepository(repoId, folder);
                    }}
                  >
                    <Icon name="folder-opened" /> Open its worktree
                  </button>
                </div>
              ) : null}
              {/* What it would change is not what happens while it cannot run. */}
              {plan && !blocked ? <Effects plan={plan} /> : null}
              {plan ? <Commands plan={plan} dimmed={blocked} /> : null}
              {sheet.error ? <p className={styles.error}>{sheet.error}</p> : null}
              <div className={styles.live} aria-live="polite">
                {announcement}
              </div>
            </div>
            <footer className={styles.footer}>
              {sheet.held ? (
                <span className={styles.held} role="note">
                  <Icon name="warning" /> Not run yet: look over what changed, then run it.
                </span>
              ) : (
                <span className={styles.keys}>
                  <kbd>Esc</kbd> cancel · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> run
                </span>
              )}
              <button
                type="button"
                className={styles.cancel}
                data-cancel
                onClick={closeSheet}
                disabled={!!sheet.running}
                title={sheet.running ? 'Git is running it: wait for it to finish' : undefined}
              >
                Cancel
              </button>
              <button
                type="button"
                data-primary
                className={[styles.run, plan?.destructive ? styles.danger : ''].join(' ')}
                // While the plan is refreshed, a click waits for it (and runs it if it can).
                disabled={!!sheet.running || (!sheet.busy && (!plan || !!plan.blocked))}
                aria-busy={sheet.queued || sheet.running ? true : undefined}
                onClick={() => void confirmSheet()}
              >
                {sheet.queued || sheet.running ? <Icon name="loading" spin /> : null}
                {notPossible ? 'Not possible' : (plan?.action ?? 'Run')}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
