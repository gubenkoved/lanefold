/**
 * The columns every graph shows (one choice, kept in the webview's storage like its other
 * preferences), and the menus that change them.
 */

import { create } from 'zustand';
import type { MenuEntry } from '../components/Menu';
import {
  COLUMN_NAMES,
  DEFAULT_COLUMNS,
  isDefaultColumns,
  parseColumns,
  sameColumns,
  shiftColumn,
  toggleColumn,
  type ColumnId,
  type GraphColumns,
} from './columns';

const STORAGE_KEY = 'lanefold.graph.columns';

function loadColumns(): GraphColumns {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_COLUMNS : parseColumns(JSON.parse(stored));
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/** The columns every graph shows. */
export const useGraphColumns = create<{ readonly columns: GraphColumns }>(() => ({
  columns: loadColumns(),
}));

/** Shows these columns in every graph from now on, and remembers them. */
export function setGraphColumns(columns: GraphColumns): void {
  if (sameColumns(columns, useGraphColumns.getState().columns)) return;
  useGraphColumns.setState({ columns });
  try {
    // The usual columns are not stored: a later version's usual columns then apply.
    if (isDefaultColumns(columns)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // Not persisted; fine.
  }
}

// Another view of the same webview origin (the panel and an editor tab) changed them.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const columns = loadColumns();
    if (!sameColumns(columns, useGraphColumns.getState().columns)) useGraphColumns.setState({ columns });
  });
}

// ---- menus -----------------------------------------------------------------------------------

/** What the columns that cost something to show say of themselves. */
const COLUMN_HINTS: Readonly<Partial<Record<ColumnId, string>>> = {
  files: 'Files added, changed and removed; read for the commits in view',
  lines: 'Lines added and removed; read for the commits in view',
};

/**
 * A checkable item per column, in their order: the message (always shown) with `message`, and
 * `dropped` ones (left out of a narrow graph) saying so.
 */
export function columnToggleEntries(
  columns: GraphColumns,
  options: {
    readonly message?: boolean;
    readonly dropped?: ReadonlySet<ColumnId>;
    readonly hint?: string;
  } = {},
): MenuEntry[] {
  return columns.order
    .filter((id) => options.message || id !== 'message')
    .map((id): MenuEntry => {
      const shown = !columns.hidden.includes(id);
      return {
        id: `column-${id}`,
        label: COLUMN_NAMES[id],
        checked: shown,
        disabled: id === 'message',
        reason: 'The commit message always shows',
        hint:
          shown && options.dropped?.has(id)
            ? 'Shown when the graph is wider'
            : (COLUMN_HINTS[id] ?? options.hint),
        onSelect: () => setGraphColumns(toggleColumn(useGraphColumns.getState().columns, id)),
      };
    });
}

/**
 * The menu of the column headings: which columns show, moving `column` (the heading it was
 * opened on) left or right, and the usual columns back. `visible`: the columns on screen;
 * `dropped`: those a narrow graph leaves out.
 */
export function columnMenuEntries(
  columns: GraphColumns,
  options: {
    readonly column?: ColumnId;
    readonly visible: readonly ColumnId[];
    readonly dropped: ReadonlySet<ColumnId>;
  },
): MenuEntry[] {
  const { column, visible, dropped } = options;
  const entries: MenuEntry[] = [
    { kind: 'header', label: 'Columns' },
    ...columnToggleEntries(columns, { message: true, dropped }),
  ];
  if (column) {
    const index = visible.indexOf(column);
    const shift = (direction: -1 | 1) => () => {
      const next = shiftColumn(useGraphColumns.getState().columns, column, direction, visible);
      if (next) setGraphColumns(next);
    };
    entries.push(
      { kind: 'separator' },
      {
        id: 'column-left',
        label: `Move ${COLUMN_NAMES[column]} left`,
        icon: 'arrow-left',
        shortcut: 'Alt+←',
        disabled: index <= 0,
        reason: 'It is the first column',
        onSelect: shift(-1),
      },
      {
        id: 'column-right',
        label: `Move ${COLUMN_NAMES[column]} right`,
        icon: 'arrow-right',
        shortcut: 'Alt+→',
        disabled: index < 0 || index >= visible.length - 1,
        reason: 'It is the last column',
        onSelect: shift(1),
      },
    );
  }
  entries.push(
    { kind: 'separator' },
    {
      id: 'column-reset',
      label: 'Reset columns',
      icon: 'discard',
      disabled: isDefaultColumns(columns),
      reason: 'The columns are as they come',
      hint: 'The usual columns, in the usual order',
      onSelect: () => setGraphColumns(DEFAULT_COLUMNS),
    },
  );
  return entries;
}
