import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleEntry } from '../../shared/models';
import { formatCommand } from '../../shared/shell';
import { CommandLine } from '../components/CommandLine';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { toast } from '../components/Toast';
import { useApp } from '../state/store';
import { consoleRows } from './consoleRows';
import styles from './ConsoleView.module.css';

type Filter = 'all' | 'changes';

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function StatusIcon({ entry }: { entry: ConsoleEntry }) {
  switch (entry.state) {
    case 'running':
      return <Icon name="loading" spin className={styles.running} title="Running" />;
    case 'ok':
      return <Icon name="pass" className={entry.readOnly ? styles.okQuiet : styles.ok} title="Succeeded" />;
    case 'error':
      return <Icon name="error" className={styles.error} title={`Failed (exit ${entry.exitCode})`} />;
    case 'cancelled':
      return <Icon name="circle-slash" className={styles.cancelled} title="Cancelled" />;
  }
}

interface ConsoleRowProps {
  /** One run, or the runs of a query repeated within moments (shown once, counted). */
  readonly runs: readonly ConsoleEntry[];
  readonly expanded: boolean;
  readonly onToggle: (id: number) => void;
}

/** Rows are made again whenever the list changes: one renders again only if one of its runs did. */
function sameRow(before: ConsoleRowProps, after: ConsoleRowProps): boolean {
  return (
    before.expanded === after.expanded &&
    before.onToggle === after.onToggle &&
    before.runs.length === after.runs.length &&
    before.runs.every((run, index) => run === after.runs[index])
  );
}

const ConsoleRow = memo(function ConsoleRow({ runs, expanded, onToggle }: ConsoleRowProps) {
  const [copied, setCopied] = useState(false);
  const first = runs[0]!;
  const repeated = runs.length > 1;
  // A repeated query shows the run still going, else the latest (its output).
  const entry = runs.find((run) => run.state === 'running') ?? runs[runs.length - 1]!;
  const duration = repeated ? Math.max(...runs.map((run) => run.durationMs ?? 0)) : entry.durationMs;
  return (
    <>
      <div
        className={styles.row}
        data-expanded={expanded}
        data-read-only={entry.readOnly}
        data-background={entry.background ?? false}
        role="button"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={() => {
          if (!window.getSelection()?.toString()) onToggle(first.id);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle(first.id);
          }
        }}
      >
        <span className={styles.status}>
          <StatusIcon entry={entry} />
        </span>
        <span className={styles.time}>{formatTime(first.startedAt)}</span>
        <CommandLine args={first.args} className={styles.command} />
        {repeated ? (
          <span
            className={styles.repeat}
            title={`${runs.length} runs within moments, as views reloaded together`}
          >
            <span aria-hidden="true">×{runs.length}</span>
            <span className="visually-hidden">, {runs.length} times</span>
          </span>
        ) : (
          <span />
        )}
        {first.label ? <span className={styles.label}>{first.label}</span> : <span />}
        <span
          className={[styles.duration, (duration ?? 0) > 1000 ? styles.slow : ''].join(' ')}
          title={repeated ? 'The longest run' : undefined}
        >
          {formatDuration(duration)}
        </span>
      </div>
      {expanded ? (
        <div className={[styles.details, entry.state === 'error' ? styles.detailsError : ''].join(' ')}>
          <div className={styles.meta}>
            <span>cwd {entry.cwd}</span>
            {entry.exitCode !== undefined && !repeated ? <span>exit {String(entry.exitCode)}</span> : null}
            <span>{new Date(first.startedAt).toLocaleString()}</span>
            {entry.readOnly ? <span>read-only</span> : null}
          </div>
          {repeated ? (
            // Each run's time: they started within moments of each other.
            <div className={styles.runs}>
              <span>Ran {runs.length} times, taking</span>
              {runs.map((run, index) => (
                <span
                  key={run.id}
                  className={styles.run}
                  title={new Date(run.startedAt).toLocaleTimeString()}
                >
                  {run.state === 'running' ? 'still running' : formatDuration(run.durationMs)}
                  {index < runs.length - 1 ? ',' : ''}
                </span>
              ))}
            </div>
          ) : null}
          <CommandLine args={entry.args} wrap className={styles.output} />
          {entry.stderr ? (
            <pre className={[styles.output, entry.state === 'error' ? styles.stderr : ''].join(' ')}>
              {entry.stderr.trimEnd()}
            </pre>
          ) : null}
          {entry.stdoutTail ? <pre className={styles.output}>{entry.stdoutTail.trimEnd()}</pre> : null}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                void navigator.clipboard.writeText(formatCommand(entry.args)).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  },
                  () => toast('Could not copy to the clipboard', { kind: 'error' }),
                );
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy command'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}, sameRow);

export function ConsoleView() {
  const entries = useApp((state) => state.consoleEntries);
  const clearConsole = useApp((state) => state.clearConsole);
  const [filter, setFilter] = useState<Filter>('changes');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<number | undefined>();
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const changes = useMemo(() => entries.filter((entry) => !entry.readOnly), [entries]);
  const visible = useMemo(() => {
    const base = filter === 'changes' ? changes : entries;
    const needle = query.trim().toLowerCase();
    return needle
      ? base.filter(
          (entry) =>
            formatCommand(entry.args).toLowerCase().includes(needle) ||
            entry.label?.toLowerCase().includes(needle),
        )
      : base;
  }, [entries, changes, filter, query]);
  const rows = useMemo(() => consoleRows(visible), [visible]);

  // Follow new output like a terminal while the user is at the bottom.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom) list.scrollTop = list.scrollHeight;
  }, [visible, atBottom]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => setAtBottom(list.scrollHeight - list.scrollTop - list.clientHeight < 24);
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, []);

  // Stable, so memoized rows only re-render when their own entry changes.
  const toggle = useCallback((id: number) => setExpanded((current) => (current === id ? undefined : id)), []);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label="Show">
          <button
            type="button"
            className={styles.segment}
            aria-pressed={filter === 'changes'}
            onClick={() => setFilter('changes')}
          >
            Changes <span className={styles.count}>{changes.length}</span>
          </button>
          <button
            type="button"
            className={styles.segment}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All commands <span className={styles.count}>{entries.length}</span>
          </button>
        </div>
        <label className={styles.search}>
          <Icon name="search" />
          <input
            value={query}
            placeholder="Filter commands"
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
        </label>
        <div className={styles.spacer} />
        <IconButton
          icon="clear-all"
          label="Clear console"
          onClick={clearConsole}
          disabled={entries.length === 0}
        />
      </div>
      <div className={styles.listWrap}>
        <div ref={listRef} className={styles.list} role="log" aria-live="polite">
          {visible.length === 0 ? (
            <EmptyState
              icon="terminal"
              title={
                entries.length === 0
                  ? 'No git commands yet'
                  : query.trim() === '' && filter === 'changes'
                    ? 'No changes made yet'
                    : 'Nothing matches'
              }
              description={
                entries.length === 0
                  ? 'Every command Lanefold runs appears here — with timing, output and a copy button.'
                  : query.trim() === '' && filter === 'changes'
                    ? 'Commands that change the repository appear here. “All commands” also shows the background queries.'
                    : 'Try a different filter.'
              }
              compact
            />
          ) : (
            rows.map((row) => (
              <ConsoleRow key={row.key} runs={row.runs} expanded={expanded === row.key} onToggle={toggle} />
            ))
          )}
        </div>
        {!atBottom && visible.length > 0 ? (
          <button
            type="button"
            className={styles.jump}
            // Toasts keep clear of it.
            data-keep-clear
            onClick={() => {
              const list = listRef.current;
              list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
            }}
          >
            <Icon name="arrow-down" /> Latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
