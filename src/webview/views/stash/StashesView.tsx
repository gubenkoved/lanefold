import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { ChangedFile, StashDetails, StashEntry } from '../../../shared/models';
import { absoluteTime, relativeLong, relativeTime } from '../../../shared/time';
import { errorText } from '../../bridge/errorText';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { openMenu } from '../../components/Menu';
import { Splitter, usePersistentSize } from '../../components/Splitter';
import { toast } from '../../components/Toast';
import { useHost } from '../../hostContext';
import { runOperation, useOperations } from '../../state/operations';
import { useQuery, useRepoVersion } from '../../state/queries';
import { showInLog, useApp } from '../../state/store';
import { useFocusWhenShown } from '../../state/viewFocus';
import { openAllDiffs } from '../log/diffActions';
import { FileList, totals, TreeToggle } from '../log/FileList';
import { commitFileEntries, fileMenu } from '../log/fileMenus';
import { STACK_BELOW, useElementWidth } from '../log/LogView';
import { ActionButton, copyWithToast, ErrorLine, LoadingLine, Section } from '../log/parts';
import styles from './StashesView.module.css';

/** "stash@{2}". */
export const stashRef = (entry: StashEntry) => `stash@{${entry.index}}`;

/** What a stash is called in lists: its message, or "WIP on main" for git's own messages. */
export function stashTitle(entry: StashEntry): string {
  return entry.generated ? `WIP on ${entry.branch ?? 'a detached HEAD'}` : entry.message;
}

/** For git's own messages, the subject of the commit it was made on ("Fix the thing"). */
function baseSubject(entry: StashEntry): string | undefined {
  return entry.generated ? entry.message.replace(/^[0-9a-f]+ /, '') : undefined;
}

/** For git's own messages, the commit it was made on ("1a2b3c4d Fix the thing"). */
function stashSubtitle(entry: StashEntry): string | undefined {
  return entry.generated ? `${entry.base.slice(0, 8)} ${baseSubject(entry)}` : undefined;
}

/**
 * Whether applying restores which changes were staged: the person's choice, else yes when the
 * stash goes back onto the commit it was made on (where that always applies cleanly).
 */
function restoresIndex(entry: StashEntry, head: string | undefined, choice: boolean | undefined): boolean {
  return choice ?? (!!head && head === entry.base);
}

function apply(entry: StashEntry, options: { pop?: boolean; index?: boolean } = {}): void {
  void runOperation({ kind: 'stashApply', stash: entry.sha, pop: options.pop, index: options.index });
}

function drop(entry: StashEntry): void {
  void runOperation({ kind: 'stashDrop', stash: entry.sha });
}

function stashMenu(entry: StashEntry, x: number, y: number, index: boolean): void {
  openMenu({ x, y }, [
    { kind: 'header', label: stashRef(entry) },
    {
      id: 'apply',
      label: 'Apply',
      icon: 'git-stash-apply',
      hint: `git stash apply${index ? ' --index' : ''}`,
      onSelect: () => apply(entry, { index }),
    },
    {
      id: 'pop',
      label: 'Pop (apply and remove)',
      icon: 'git-stash-pop',
      hint: `git stash pop${index ? ' --index' : ''}`,
      onSelect: () => apply(entry, { pop: true, index }),
    },
    { kind: 'separator' },
    {
      id: 'base',
      label: 'Show the commit it was made on',
      icon: 'go-to-file',
      onSelect: () => showInLog(useApp.getState().activeRepoId ?? '', entry.base),
    },
    {
      id: 'copy',
      label: 'Copy stash hash',
      icon: 'copy',
      onSelect: () => void copyWithToast(entry.sha, 'stash hash'),
    },
    { kind: 'separator' },
    { id: 'drop', label: 'Drop…', icon: 'trash', danger: true, onSelect: () => drop(entry) },
  ]);
}

function StashRow({
  entry,
  selected,
  onSelect,
  onMenu,
  onApply,
}: {
  entry: StashEntry;
  selected: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  onApply: () => void;
}) {
  const subtitle = stashSubtitle(entry);
  return (
    <div
      role="option"
      id={`stash-${entry.sha}`}
      aria-selected={selected}
      className={styles.row}
      onClick={onSelect}
      onDoubleClick={onApply}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        onMenu(event.clientX, event.clientY);
      }}
      title={`${stashRef(entry)}: ${entry.subject}`}
    >
      <span className={styles.rowIcon}>
        <Icon name="git-stash" />
      </span>
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>
          {stashTitle(entry)}
          {subtitle ? <span className={styles.rowSubtitle}>{subtitle}</span> : null}
        </span>
        <span className={styles.rowMeta}>
          <code>{stashRef(entry)}</code>
          {entry.branch && !entry.generated ? (
            <span className={styles.branch}>
              <Icon name="git-branch" />
              {entry.branch}
            </span>
          ) : null}
          <span title={absoluteTime(entry.time)}>{relativeTime(entry.time)}</span>
          {entry.untracked ? <span className={styles.badge}>+ untracked</span> : null}
        </span>
      </span>
    </div>
  );
}

function stashDiffTitle(file: ChangedFile, entry: StashEntry): string {
  return `${file.path.slice(file.path.lastIndexOf('/') + 1)} (${stashRef(entry)})`;
}

function StashDetailsPane({
  repoId,
  entry,
  restoreIndex,
  onRestoreIndex,
}: {
  repoId: string;
  entry: StashEntry;
  restoreIndex: boolean | undefined;
  onRestoreIndex: (value: boolean) => void;
}) {
  const host = useHost();
  const head = useApp((state) => state.heads[repoId]);
  const running = useOperations((state) => state.running);
  const details = useQuery<StashDetails>(`${repoId}:${entry.sha}`, () =>
    host.rpc.call('stash.details', { repoId, sha: entry.sha }),
  );
  const data = details.data?.sha === entry.sha ? details.data : undefined;
  const staged = new Set(data?.staged.map((file) => file.path));
  const index = staged.size > 0 && restoresIndex(entry, head?.sha, restoreIndex);
  const openFile = (file: ChangedFile, base: string | undefined, target: string) => {
    const left =
      file.status === 'A' || base === undefined ? undefined : { path: file.oldPath ?? file.path, rev: base };
    const right = file.status === 'D' ? undefined : { path: file.path, rev: target };
    void host.rpc
      .call('diff.open', { repoId, title: stashDiffTitle(file, entry), left, right })
      .catch((error: unknown) =>
        toast('Could not open the diff', { kind: 'error', detail: errorText(error) }),
      );
  };
  const title = `${stashRef(entry)} ${stashTitle(entry)}`;

  return (
    <div className={styles.details}>
      <header className={styles.header}>
        <h2 className={styles.subject}>{stashTitle(entry)}</h2>
        <div className={styles.when}>
          <code>{stashRef(entry)}</code> · stashed {relativeLong(entry.time)}
          {entry.branch ? ` on ${entry.branch}` : ''} at{' '}
          <button
            type="button"
            className={styles.link}
            title="Show this commit in the graph"
            onClick={() => showInLog(repoId, entry.base)}
          >
            {entry.base.slice(0, 8)}
          </button>
          {baseSubject(entry) ? ` “${baseSubject(entry)}”` : ''}
        </div>
        <div className={styles.actions}>
          <ActionButton
            icon="git-stash-apply"
            label="Apply"
            primary
            disabled={!!running}
            title="Bring these changes back; the stash stays on the list"
            onClick={() => apply(entry, { index })}
          />
          <ActionButton
            icon="git-stash-pop"
            label="Pop"
            disabled={!!running}
            title="Bring these changes back and remove the stash from the list"
            onClick={() => apply(entry, { pop: true, index })}
          />
          <ActionButton
            icon="trash"
            label="Drop…"
            disabled={!!running}
            title="Remove the stash from the list (Undo puts it back)"
            onClick={() => drop(entry)}
          />
          {staged.size > 0 ? (
            <label
              className={styles.option}
              title="Also restore which changes were staged (git stash apply --index)"
            >
              <input
                type="checkbox"
                checked={index}
                onChange={(event) => onRestoreIndex(event.target.checked)}
              />
              Restore staged state
            </label>
          ) : null}
        </div>
      </header>
      <div className={styles.files}>
        {!data ? (
          details.error ? (
            <ErrorLine error={details.error} />
          ) : (
            <LoadingLine text="Loading the stash…" />
          )
        ) : (
          <>
            <Section
              title="Changes"
              count={data.files.length}
              stats={totals(data.files)}
              actions={
                <>
                  <TreeToggle />
                  <ActionButton
                    icon="diff-multiple"
                    label="Open all"
                    title="Open every change in this stash in a multi-file diff"
                    collapsible
                    disabled={data.files.length === 0}
                    onClick={() => openAllDiffs(host.rpc, repoId, title, data.files, data.base, data.sha)}
                  />
                </>
              }
            >
              <FileList
                files={data.files}
                emptyText="No changes to tracked files."
                onOpen={(file) => openFile(file, data.base, data.sha)}
                // A stash is a commit: its files can be restored, applied or reverted one by one.
                onContextMenu={(file, event) =>
                  fileMenu(
                    file,
                    event,
                    () => openFile(file, data.base, data.sha),
                    commitFileEntries(repoId, file, data.sha, data.base),
                  )
                }
                badge={(file) =>
                  staged.has(file.path) ? (
                    <span className={styles.staged} title="This change was staged">
                      staged
                    </span>
                  ) : null
                }
              />
            </Section>
            {data.untracked.length > 0 && data.untrackedCommit ? (
              <Section title="Untracked files" count={data.untracked.length}>
                <FileList
                  files={data.untracked}
                  untracked
                  onOpen={(file) => openFile(file, undefined, data.untrackedCommit!)}
                />
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export interface StashesViewProps {
  readonly repoId: string;
  readonly active: boolean;
}

/** The stash list, with what each stash holds and the actions to bring it back. */
export function StashesView({ repoId, active }: StashesViewProps) {
  const host = useHost();
  const version = useRepoVersion(host.rpc, repoId, ['stash', 'refs', 'head']);
  const list = useQuery(active ? `${repoId}:${version}` : undefined, () =>
    host.rpc.call('stash.list', { repoId }),
  );
  const workingTree = useQuery(active ? `${repoId}:wt:${version}` : undefined, () =>
    host.rpc.call('repo.workingTree', { repoId }),
  );
  // The selected stash, and where it was: when it leaves the list, its neighbour takes its place.
  const [selection, setSelection] = useState<{ sha: string; index: number }>();
  const [restoreIndex, setRestoreIndex] = useState<Record<string, boolean>>({});
  const head = useApp((state) => state.heads[repoId]?.sha);
  /** Every way of applying a stash (button, Enter, double-click, menu) restores the index alike. */
  const withIndex = (entry: StashEntry) => restoresIndex(entry, head, restoreIndex[entry.sha]);
  const [width, setWidth] = usePersistentSize('stashes.details', 460);
  const [height, setHeight] = usePersistentSize('stashes.details.height', 280);
  const listRef = useRef<HTMLDivElement>(null);
  const rootElement = useRef<HTMLDivElement | null>(null);
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootElement.current = element;
      rootRef(element);
    },
    [rootRef],
  );
  // Narrow panels put the details under the list, as the log does.
  const stacked = rootWidth > 0 && rootWidth < STACK_BELOW;

  // Opened from a menu or a button: the list takes focus, so the arrow keys work right away
  // (with no stashes, the button that makes one, when there is something to stash).
  useFocusWhenShown('stashes', active && !!list.data, () => {
    (listRef.current ?? rootElement.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    return true;
  });

  const entries = list.data ?? [];
  const selected =
    entries.find((entry) => entry.sha === selection?.sha) ??
    entries[Math.min(selection?.index ?? 0, entries.length - 1)];
  const select = (entry: StashEntry) => setSelection({ sha: entry.sha, index: entry.index });
  const tree = workingTree.data;
  const dirty = !!tree && tree.staged + tree.unstaged + tree.untracked > 0;
  const stashChanges = () =>
    void runOperation({ kind: 'stashPush', includeUntracked: !!tree && tree.untracked > 0 });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    const move = (delta: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, selected.index + delta))];
      if (next) {
        select(next);
        document.getElementById(`stash-${next.sha}`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Home') move(-entries.length);
    else if (event.key === 'End') move(entries.length);
    // Enter opens what a stash holds, as it does for commits elsewhere; applying changes the
    // working tree, so it stays an explicit choice (the button, or the menu).
    else if (event.key === 'Enter') {
      const entry = selected;
      void host.rpc
        .call('stash.details', { repoId, sha: entry.sha })
        .then((details) =>
          openAllDiffs(
            host.rpc,
            repoId,
            `${stashRef(entry)} ${stashTitle(entry)}`,
            details.files,
            details.base,
            details.sha,
          ),
        )
        .catch((error: unknown) =>
          toast('Could not open the stash', { kind: 'error', detail: errorText(error) }),
        );
    } else if (event.key === 'Delete') drop(selected);
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const rect = document.getElementById(`stash-${selected.sha}`)?.getBoundingClientRect();
      if (rect) stashMenu(selected, rect.left + 24, rect.bottom, withIndex(selected));
    } else return;
    event.preventDefault();
  };

  if (list.error) return <ErrorLine error={list.error} />;
  if (!list.data) return <LoadingLine text="Reading the stash list…" />;

  const toolbar = (
    <div className={styles.toolbar}>
      <Icon name="git-stash" className={styles.toolbarIcon} />
      <span className={styles.toolbarTitle}>
        {entries.length === 0 ? 'Stashes' : `${entries.length} stash${entries.length === 1 ? '' : 'es'}`}
      </span>
      <span className={styles.spacer} />
      {/* Without stashes, the empty view offers it. */}
      {entries.length > 0 ? (
        <ActionButton
          icon="git-stash"
          label="Stash changes…"
          primary
          disabled={!dirty}
          title={dirty ? 'Set your uncommitted changes aside' : 'There are no uncommitted changes to stash'}
          onClick={stashChanges}
        />
      ) : null}
    </div>
  );

  if (entries.length === 0) {
    return (
      <div ref={setRoot} className={styles.root}>
        {toolbar}
        <EmptyState
          icon="git-stash"
          title="No stashes"
          description="Stashing sets uncommitted changes aside — to switch branches, pull, or try something else — so you can bring them back later."
          actions={
            dirty ? (
              <ActionButton icon="git-stash" label="Stash changes…" primary onClick={stashChanges} />
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <div ref={setRoot} className={styles.root}>
      {toolbar}
      <div className={styles.body} data-stacked={stacked}>
        <div
          ref={listRef}
          className={styles.list}
          role="listbox"
          aria-label="Stashes"
          tabIndex={0}
          aria-activedescendant={selected ? `stash-${selected.sha}` : undefined}
          onKeyDown={onKeyDown}
        >
          {entries.map((entry) => (
            <StashRow
              key={entry.sha}
              entry={entry}
              selected={entry.sha === selected?.sha}
              onSelect={() => {
                select(entry);
                listRef.current?.focus();
              }}
              onMenu={(x, y) => stashMenu(entry, x, y, withIndex(entry))}
              onApply={() => apply(entry, { index: withIndex(entry) })}
            />
          ))}
        </div>
        <Splitter
          orientation={stacked ? 'horizontal' : 'vertical'}
          size={stacked ? height : width}
          min={stacked ? 160 : 280}
          max={900}
          defaultSize={stacked ? 280 : 460}
          onResize={stacked ? setHeight : setWidth}
          label="Resize stash details"
        />
        <aside className={styles.side} style={stacked ? { height } : { width }} aria-label="Stash details">
          {selected ? (
            <StashDetailsPane
              key={selected.sha}
              repoId={repoId}
              entry={selected}
              restoreIndex={restoreIndex[selected.sha]}
              onRestoreIndex={(value) => setRestoreIndex((state) => ({ ...state, [selected.sha]: value }))}
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
