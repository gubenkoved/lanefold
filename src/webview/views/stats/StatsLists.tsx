import { useId, useState, type KeyboardEvent } from 'react';
import type { Contributor, Hotspot, HotspotGroup } from '../../../shared/stats';
import { Icon } from '../../components/Icon';
import { absoluteTime, relativeLong } from '../../graph/format';
import { Avatar } from '../log/parts';
import { dateRange, percent, plural } from './statsTab';
import styles from './StatsView.module.css';

/**
 * The cursor of a list (aria-activedescendant, as the reflog's): arrow keys, Page Up/Down,
 * Home/End move it; Enter acts on its row.
 */
function useCursor(id: string, count: number, onEnter: (index: number) => void) {
  const [cursor, setCursor] = useState(0);
  const current = Math.min(cursor, Math.max(0, count - 1));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const move = (to: number) => {
      const next = Math.min(count - 1, Math.max(0, to));
      setCursor(next);
      document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown') move(current + 1);
    else if (event.key === 'ArrowUp') move(current - 1);
    else if (event.key === 'PageDown') move(current + 10);
    else if (event.key === 'PageUp') move(current - 10);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(count - 1);
    else if ((event.key === 'Enter' || event.key === ' ') && count > 0) onEnter(current);
    else return;
    event.preventDefault();
  };
  return { cursor: current, setCursor, onKeyDown };
}

/** "Show 3 more", or "Show 25 more · 1,204 not shown". */
function moreText(hidden: number, step: number): string {
  return hidden <= step
    ? `Show ${hidden.toLocaleString()} more`
    : `Show ${step.toLocaleString()} more · ${hidden.toLocaleString()} not shown`;
}

function lineCounts(added: number, removed: number) {
  return (
    <>
      <span className={styles.plus}>+{added.toLocaleString()}</span>{' '}
      <span className={styles.minus}>−{removed.toLocaleString()}</span>
    </>
  );
}

/**
 * Who made the commits shown: a row per author with their share, lines and when they were
 * active. Choosing a row filters the view to that author (`author`: the one filtered to).
 */
export function ContributorList({
  rows,
  total,
  author,
  onPick,
  onMore,
}: {
  rows: readonly Contributor[];
  total: number;
  author?: string;
  onPick: (contributor: Contributor) => void;
  onMore: () => void;
}) {
  const id = useId();
  const { cursor, setCursor, onKeyDown } = useCursor(id, rows.length, (index) => onPick(rows[index]!));
  const leader = Math.max(...rows.map((row) => row.share), 0);
  return (
    <>
      <div className={styles.listHead} aria-hidden="true">
        <span>Author</span>
        <span>Commits</span>
        <span className={styles.wideOnly}>Lines</span>
        <span className={styles.wideOnly}>First – last commit</span>
        <span className={styles.wideOnly}>Active</span>
      </div>
      <div
        className={styles.list}
        role="listbox"
        aria-label="Contributors"
        tabIndex={0}
        aria-activedescendant={rows.length > 0 ? `${id}-${cursor}` : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => {
          const filtered = row.author === author;
          return (
            <div
              key={row.author}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === cursor}
              aria-current={filtered || undefined}
              aria-label={`${row.name}: ${plural(row.commits, 'commit')} (${percent(row.share)}), ${row.added.toLocaleString()} lines added, ${row.removed.toLocaleString()} removed, ${dateRange(row.first, row.last)}, active on ${plural(row.activeDays, 'day')}${filtered ? ', shown' : ''}`}
              className={styles.contributor}
              data-filtered={filtered || undefined}
              onClick={() => {
                setCursor(index);
                onPick(row);
              }}
            >
              <Avatar name={row.name} email={row.email} size={22} />
              <span className={styles.who} title={row.emails.join('\n')}>
                <span className={styles.name}>{row.name}</span>
                <span className={styles.email}>{row.email}</span>
              </span>
              <span className={styles.share}>
                <span className={styles.meter}>
                  {/* The leader's bar is full: shares compare at a glance. */}
                  <span style={{ width: `${leader > 0 ? (row.share / leader) * 100 : 0}%` }} />
                </span>
                <span className={styles.shareText}>{row.commits.toLocaleString()}</span>
                <span className={styles.percent}>{percent(row.share)}</span>
              </span>
              <span className={styles.lineCell}>{lineCounts(row.added, row.removed)}</span>
              <span
                className={styles.dates}
                title={`${absoluteTime(row.first)} – ${absoluteTime(row.last)} (the last ${relativeLong(row.last)})`}
              >
                {dateRange(row.first, row.last)}
              </span>
              <span className={styles.days}>{plural(row.activeDays, 'day')}</span>
            </div>
          );
        })}
      </div>
      {rows.length < total ? (
        <button type="button" className={styles.more} onClick={onMore}>
          {moreText(total - rows.length, 25)}
        </button>
      ) : null}
    </>
  );
}

function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { folder: '', name: path }
    : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The files (or folders) changed most often; choosing one opens its history. */
export function HotspotList({
  rows,
  total,
  group,
  onOpen,
  onMore,
}: {
  rows: readonly Hotspot[];
  total: number;
  group: HotspotGroup;
  onOpen: (hotspot: Hotspot) => void;
  onMore: () => void;
}) {
  const id = useId();
  const open = (index: number) => {
    const row = rows[index]!;
    if (group === 'files' || row.path) onOpen(row);
  };
  const { cursor, setCursor, onKeyDown } = useCursor(id, rows.length, open);
  const most = Math.max(1, ...rows.map((row) => row.commits));
  const label = group === 'files' ? 'Files changed most often' : 'Folders changed most often';
  return (
    <>
      <div className={styles.listHead} data-kind="hotspots" aria-hidden="true">
        <span>{group === 'files' ? 'File' : 'Folder'}</span>
        <span>Commits</span>
        <span className={styles.wideOnly}>Lines</span>
        <span className={styles.wideOnly}>Authors</span>
      </div>
      <div
        className={styles.list}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        aria-activedescendant={rows.length > 0 ? `${id}-${cursor}` : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => {
          const { folder, name } = splitPath(row.path);
          const top = group === 'folders' && !row.path;
          const shown = top ? 'Files at the top level' : group === 'folders' ? `${row.path}/` : row.path;
          return (
            <div
              key={row.path}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === cursor}
              aria-label={`${shown}: ${plural(row.commits, 'commit')}, ${row.added.toLocaleString()} lines added, ${row.removed.toLocaleString()} removed, ${plural(row.authors, 'author')}`}
              className={styles.hotspot}
              data-static={top || undefined}
              title={top ? undefined : `Show the history of ${shown}`}
              onClick={() => {
                setCursor(index);
                open(index);
              }}
            >
              <span className={styles.path}>
                <Icon
                  name={group === 'files' ? 'file' : top ? 'files' : 'folder'}
                  className={styles.pathIcon}
                />
                {group === 'files' ? (
                  <span className={styles.pathText}>
                    {name}
                    {folder ? <span className={styles.folder}>{folder.slice(0, -1)}</span> : null}
                  </span>
                ) : (
                  <span className={styles.pathText}>{shown}</span>
                )}
              </span>
              <span className={styles.share}>
                <span className={styles.meter}>
                  <span style={{ width: `${(row.commits / most) * 100}%` }} />
                </span>
                <span className={styles.shareText}>{row.commits.toLocaleString()}</span>
              </span>
              <span className={styles.lineCell}>{lineCounts(row.added, row.removed)}</span>
              <span className={styles.days}>
                <Icon name="person" className={styles.authorsIcon} /> {row.authors.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
      {rows.length < total ? (
        <button type="button" className={styles.more} onClick={onMore}>
          {moreText(total - rows.length, 20)}
        </button>
      ) : null}
    </>
  );
}
