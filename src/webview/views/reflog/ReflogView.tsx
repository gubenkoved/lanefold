import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CommitDetails, ReflogEntry } from '../../../shared/models';
import { absoluteTime, relativeLong, relativeTime } from '../../../shared/time';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { Splitter, usePersistentSize } from '../../components/Splitter';
import { shortSha } from '../../graph/format';
import { useHost } from '../../hostContext';
import { runOperation } from '../../state/operations';
import { fetchCommitDetails, useQuery, useRepoVersion } from '../../state/queries';
import { showInLog, useApp } from '../../state/store';
import { useFocusWhenShown } from '../../state/viewFocus';
import { openAllDiffs, openFileDiff } from '../log/diffActions';
import { FileList, totals, TreeToggle } from '../log/FileList';
import { commitFileEntries, fileMenu } from '../log/fileMenus';
import { STACK_BELOW, useElementWidth } from '../log/LogView';
import { ActionButton, copyWithToast, ErrorLine, LoadingLine, Section, ShaChip } from '../log/parts';
import styles from './ReflogView.module.css';
import { describeReflog, reflogMessage, type HeadBranch } from './reflogText';

const PAGE = 200;
const MAX = 5000;

/** An icon for what moved HEAD. */
function actionIcon(action: string): string {
  if (action.startsWith('commit')) return 'git-commit';
  if (action.startsWith('checkout') || action.startsWith('switch')) return 'arrow-swap';
  if (action.startsWith('reset')) return 'history';
  if (action.startsWith('rebase')) return 'git-pull-request';
  if (action.startsWith('merge')) return 'git-merge';
  if (action.startsWith('pull')) return 'arrow-down';
  if (action.startsWith('cherry-pick') || action.startsWith('revert'))
    return 'git-pull-request-go-to-changes';
  if (action.startsWith('lanefold')) return 'sparkle';
  return 'circle-small-filled';
}

/**
 * What identifies an entry across reloads: its `HEAD@{n}` number shifts by one each time HEAD
 * moves, the commit, time and action do not.
 */
const entryKey = (entry: ReflogEntry) => `${entry.sha}:${entry.time}:${entry.action}:${entry.detail}`;

/**
 * The selected entry: where it was, if that is still it; else, after HEAD moved, the same entry
 * further down (two alike, the same move twice within a second, are told apart by where they
 * are); else what took its place.
 */
function findSelected(
  entries: readonly ReflogEntry[],
  selection: { key?: string; index: number },
): ReflogEntry | undefined {
  const there = entries.find((entry) => entry.index === selection.index);
  if (!selection.key || (there && entryKey(there) === selection.key)) return there ?? entries[0];
  const moved = entries.filter((entry) => entryKey(entry) === selection.key);
  return moved.find((entry) => entry.index > selection.index) ?? moved[0] ?? there ?? entries[0];
}

function entryActions(repoId: string, entry: ReflogEntry): MenuEntry[] {
  return [
    {
      id: 'reveal',
      label: 'Show in the graph',
      icon: 'go-to-file',
      disabled: entry.lost,
      reason: 'No branch reaches it any more: a new branch here brings it back to the graph',
      onSelect: () => showInLog(repoId, entry.sha),
    },
    {
      id: 'branch',
      label: 'New branch here…',
      icon: 'git-branch-create',
      hint: `git switch -c <name> ${shortSha(entry.sha)}`,
      onSelect: () => void runOperation({ kind: 'createBranch', name: '', at: entry.sha, checkout: true }),
    },
    {
      id: 'checkout',
      label: 'Check out (detached)',
      icon: 'target',
      hint: `git switch --detach ${shortSha(entry.sha)}`,
      onSelect: () => void runOperation({ kind: 'checkout', target: entry.sha, detach: true }),
    },
    {
      id: 'reset',
      label: 'Reset the current branch here…',
      icon: 'history',
      hint: `git reset <mode> ${shortSha(entry.sha)}`,
      onSelect: () => void runOperation({ kind: 'reset', to: entry.sha, mode: 'keep' }, { review: true }),
    },
    { kind: 'separator' },
    {
      id: 'copy',
      label: 'Copy commit hash',
      icon: 'copy',
      onSelect: () => void copyWithToast(entry.sha, 'hash'),
    },
  ];
}

function EntryDetails({ repoId, entry }: { repoId: string; entry: ReflogEntry }) {
  const host = useHost();
  const details = useQuery<CommitDetails>(`${repoId}:${entry.sha}`, () =>
    fetchCommitDetails(host.rpc, repoId, entry.sha),
  );
  const data = details.data?.sha === entry.sha ? details.data : undefined;
  const files = data?.files ?? [];
  return (
    <div className={styles.details}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <code>HEAD@{`{${entry.index}}`}</code> ·{' '}
          <span title={absoluteTime(entry.time)}>{relativeLong(entry.time)}</span>
          {/* What git noted, word for word. */}
          <code className={styles.raw} title="What git noted in the reflog">
            {reflogMessage(entry)}
          </code>
        </div>
        <h2 className={styles.subject}>{entry.subject || <em>(no message)</em>}</h2>
        {data ? (
          <div className={styles.when}>
            {data.author} · authored{' '}
            <span title={absoluteTime(data.authorTime)}>{relativeLong(data.authorTime)}</span>
          </div>
        ) : null}
        <div className={styles.chips}>
          <ShaChip sha={entry.sha} />
        </div>
        {entry.lost ? (
          <div className={styles.lost} role="note">
            <Icon name="warning" />
            <span>
              No branch or tag holds this commit any more: only the reflog does, and git eventually forgets
              it. Put a branch on it to keep it.
            </span>
          </div>
        ) : null}
        <div className={styles.actions}>
          <ActionButton
            icon="git-branch-create"
            label="New branch here…"
            primary={entry.lost}
            onClick={() =>
              void runOperation({ kind: 'createBranch', name: '', at: entry.sha, checkout: true })
            }
          />
          <ActionButton
            icon="go-to-file"
            label="Show in the graph"
            primary={!entry.lost}
            disabled={entry.lost}
            title={
              entry.lost ? 'No view shows it: no branch or tag holds it' : 'Show this commit in the graph'
            }
            onClick={() => showInLog(repoId, entry.sha)}
          />
          <ActionButton
            icon="target"
            label="Check out"
            collapsible
            title={`Check out ${shortSha(entry.sha)} (detached HEAD)`}
            onClick={() => void runOperation({ kind: 'checkout', target: entry.sha, detach: true })}
          />
          <ActionButton
            icon="history"
            label="Reset here…"
            collapsible
            title="Move the current branch to this commit (reviewed first)"
            onClick={() =>
              void runOperation({ kind: 'reset', to: entry.sha, mode: 'keep' }, { review: true })
            }
          />
        </div>
      </header>
      <div className={styles.files}>
        {data?.body ? <pre>{data.body}</pre> : null}
        <Section
          title="Changes"
          count={data ? files.length : undefined}
          stats={data ? totals(files) : undefined}
          actions={
            <>
              <TreeToggle />
              <ActionButton
                icon="diff-multiple"
                label="Open all"
                collapsible
                disabled={files.length === 0}
                onClick={() =>
                  openAllDiffs(
                    host.rpc,
                    repoId,
                    `${shortSha(entry.sha)} ${entry.subject}`,
                    files,
                    data?.diffBase,
                    entry.sha,
                  )
                }
              />
            </>
          }
        >
          {data ? (
            <FileList
              files={files}
              emptyText="This commit changes no files."
              onOpen={(file) => openFileDiff(host.rpc, repoId, file, data.diffBase, entry.sha)}
              onContextMenu={(file, event) =>
                fileMenu(
                  file,
                  event,
                  () => openFileDiff(host.rpc, repoId, file, data.diffBase, entry.sha),
                  commitFileEntries(repoId, file, entry.sha, data.diffBase),
                )
              }
            />
          ) : details.error ? (
            <ErrorLine error={details.error} />
          ) : (
            <LoadingLine text="Loading the commit…" />
          )}
        </Section>
      </div>
    </div>
  );
}

export interface ReflogViewProps {
  readonly repoId: string;
  readonly active: boolean;
}

/** Everywhere HEAD has been, newest first: the way back to work a reset or rebase left behind. */
export function ReflogView({ repoId, active }: ReflogViewProps) {
  const host = useHost();
  const version = useRepoVersion(host.rpc, repoId);
  const [limit, setLimit] = useState(PAGE);
  const list = useQuery(active ? `${repoId}:${version}:${limit}` : undefined, () =>
    host.rpc.call('reflog.list', { repoId, limit }),
  );
  // The selected entry, and where it was (for when it is gone from the list).
  const [selection, setSelection] = useState<{ key?: string; index: number }>({ index: 0 });
  const [lostOnly, setLostOnly] = useState(false);
  const [width, setWidth] = usePersistentSize('reflog.details', 460);
  const [height, setHeight] = usePersistentSize('reflog.details.height', 280);
  const listRef = useRef<HTMLDivElement>(null);
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  // Narrow panels put the details under the list, as the log does.
  const stacked = rootWidth > 0 && rootWidth < STACK_BELOW;

  // The entries in words, which take where HEAD is now into account.
  const head = useApp((state) => state.heads[repoId]);
  const branch: HeadBranch = head ? (head.detached ? null : head.branch) : undefined;
  const titles = useMemo(() => {
    const data = list.data ?? [];
    const words = describeReflog(data, branch);
    return new Map(data.map((entry, index) => [entry.index, words[index]!]));
  }, [list.data, branch]);

  const all = list.data ?? [];
  const entries = lostOnly ? all.filter((entry) => entry.lost) : all;
  const selected = findSelected(entries, selection);
  const lostCount = all.filter((entry) => entry.lost).length;

  // Opened from a menu: the list takes focus, so the arrow keys work right away.
  useFocusWhenShown('reflog', active && !!list.data, () => {
    listRef.current?.focus();
    return true;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    const position = entries.indexOf(selected);
    const move = (delta: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, position + delta))];
      if (!next) return;
      setSelection({ key: entryKey(next), index: next.index });
      document.getElementById(`reflog-${next.index}`)?.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'PageDown') move(10);
    else if (event.key === 'PageUp') move(-10);
    else if (event.key === 'Home') move(-entries.length);
    else if (event.key === 'End') move(entries.length);
    else if (event.key === 'Enter' && !selected.lost) showInLog(repoId, selected.sha);
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const element = document.getElementById(`reflog-${selected.index}`);
      if (element) openMenu(element, entryActions(repoId, selected));
    } else return;
    event.preventDefault();
  };

  if (list.error) return <ErrorLine error={list.error} />;
  if (!list.data) return <LoadingLine text="Reading the reflog…" />;

  const toolbar = (
    <div className={styles.toolbar}>
      <Icon name="history" className={styles.toolbarIcon} />
      <span className={styles.toolbarTitle}>Reflog</span>
      <span className={styles.toolbarNote}>where HEAD has been, newest first</span>
      <span className={styles.spacer} />
      {lostCount > 0 || lostOnly ? (
        <label className={styles.option} title="Only commits no branch or tag holds any more">
          <input type="checkbox" checked={lostOnly} onChange={(event) => setLostOnly(event.target.checked)} />
          Lost commits only ({lostCount})
        </label>
      ) : null}
    </div>
  );

  if (all.length === 0) {
    return (
      <div ref={rootRef} className={styles.root}>
        {toolbar}
        <EmptyState
          icon="history"
          title="The reflog is empty"
          description="Git records here every commit HEAD points to: after commits, checkouts, resets and rebases you can always find your way back."
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className={styles.root}>
      {toolbar}
      <div className={styles.body} data-stacked={stacked}>
        {/* The list and, after it, what is not one of its entries (a listbox holds options only). */}
        <div className={styles.list}>
          <div
            ref={listRef}
            className={styles.options}
            role="listbox"
            aria-label="Reflog"
            tabIndex={0}
            aria-activedescendant={selected ? `reflog-${selected.index}` : undefined}
            onKeyDown={onKeyDown}
          >
            {entries.map((entry) => (
              <div
                key={entry.index}
                id={`reflog-${entry.index}`}
                role="option"
                aria-selected={entry === selected}
                className={styles.row}
                data-lost={entry.lost}
                onClick={() => {
                  setSelection({ key: entryKey(entry), index: entry.index });
                  listRef.current?.focus();
                }}
                onDoubleClick={() => !entry.lost && showInLog(repoId, entry.sha)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelection({ key: entryKey(entry), index: entry.index });
                  openMenu({ x: event.clientX, y: event.clientY }, entryActions(repoId, entry));
                }}
                title={`HEAD@{${entry.index}}: ${reflogMessage(entry)}`}
              >
                <Icon name={actionIcon(entry.action)} className={styles.rowIcon} />
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{titles.get(entry.index) ?? reflogMessage(entry)}</span>
                  <span className={styles.rowMeta}>
                    <code>HEAD@{`{${entry.index}}`}</code>
                    <code>{shortSha(entry.sha)}</code>
                    {entry.lost ? <span className={styles.lostBadge}>lost</span> : null}
                  </span>
                </span>
                <span className={styles.rowTime} title={absoluteTime(entry.time)}>
                  {relativeTime(entry.time)}
                </span>
              </div>
            ))}
          </div>
          {entries.length === 0 ? <p className={styles.none}>No lost commits among these entries.</p> : null}
          {all.length >= limit && limit < MAX ? (
            <button
              type="button"
              className={styles.more}
              onClick={() => setLimit(Math.min(MAX, limit + 500))}
            >
              Show older entries
            </button>
          ) : null}
        </div>
        <Splitter
          orientation={stacked ? 'horizontal' : 'vertical'}
          size={stacked ? height : width}
          min={stacked ? 160 : 280}
          max={900}
          defaultSize={stacked ? 280 : 460}
          onResize={stacked ? setHeight : setWidth}
          label="Resize reflog details"
        />
        <aside className={styles.side} style={stacked ? { height } : { width }} aria-label="Reflog entry">
          {selected ? <EntryDetails key={entryKey(selected)} repoId={repoId} entry={selected} /> : null}
        </aside>
      </div>
    </div>
  );
}
