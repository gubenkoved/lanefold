/**
 * The graph's columns after the lanes (which always come first): which of them show and in what
 * order, and which a narrow graph leaves out. The choice itself, one for every graph, is kept by
 * columnMenus.ts.
 */

/** A column of the graph after the lanes. */
export type ColumnId = 'message' | 'author' | 'date' | 'sha' | 'files' | 'lines';

/** Every column, in the order they come in. */
export const COLUMN_IDS: readonly ColumnId[] = ['message', 'author', 'date', 'sha', 'files', 'lines'];

/**
 * Columns that are off until switched on: how many files and lines each commit changed. git is
 * asked for them only while they show (see commitStats.ts), the lines costing the most.
 */
export const OPTIONAL_COLUMNS: readonly ColumnId[] = ['files', 'lines'];

export interface GraphColumns {
  /** Every column, in the order shown (a column switched off keeps its place for when it is back). */
  readonly order: readonly ColumnId[];
  /** Columns switched off (never the message), in {@link COLUMN_IDS} order. */
  readonly hidden: readonly ColumnId[];
}

export const DEFAULT_COLUMNS: GraphColumns = { order: COLUMN_IDS, hidden: OPTIONAL_COLUMNS };

/** What the column headings say. */
export const COLUMN_HEADINGS: Readonly<Record<ColumnId, string>> = {
  message: 'Commit message',
  author: 'Author',
  date: 'Date',
  sha: 'Commit',
  files: 'Files',
  lines: 'Lines',
};

/** What menus call the columns (out of the heading's context, "Commit" alone says too little). */
export const COLUMN_NAMES: Readonly<Record<ColumnId, string>> = {
  message: 'Commit message',
  author: 'Author',
  date: 'Date',
  sha: 'Commit hash',
  files: 'Files changed',
  lines: 'Lines changed',
};

/** Widths (px) of the columns after the lanes; the message takes the room that is left. */
export const COLUMN_WIDTHS: Readonly<Record<Exclude<ColumnId, 'message'>, number>> = {
  author: 168,
  date: 104,
  sha: 84,
  // Three counts (added, changed, removed) and two, of five characters at most each ("+1.4K").
  files: 132,
  lines: 96,
};

/** Room (px) the message and narrow lanes keep: columns are left out of a graph with less. */
const MESSAGE_ROOM = 364;
/** What a narrow graph leaves out first: the counts, the hash, then the author (the date stays). */
const DROPPED_FIRST: readonly ColumnId[] = ['lines', 'files', 'sha', 'author'];

export function isColumnId(value: unknown): value is ColumnId {
  return typeof value === 'string' && (COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * Columns as stored (maybe by another version, maybe garbled): what is valid of them. Columns it
 * does not name (newer ones) come last, shown or not as they usually are; anything unusable gives
 * the usual columns.
 */
export function parseColumns(value: unknown): GraphColumns {
  if (!value || typeof value !== 'object') return DEFAULT_COLUMNS;
  const { order, hidden } = value as { order?: unknown; hidden?: unknown };
  if (!Array.isArray(order)) return DEFAULT_COLUMNS;
  const named = order.filter((id, index): id is ColumnId => isColumnId(id) && order.indexOf(id) === index);
  return {
    order: [...named, ...COLUMN_IDS.filter((id) => !named.includes(id))],
    hidden: COLUMN_IDS.filter(
      (id) =>
        id !== 'message' &&
        (named.includes(id)
          ? Array.isArray(hidden) && (hidden as unknown[]).includes(id)
          : OPTIONAL_COLUMNS.includes(id)),
    ),
  };
}

export function sameColumns(a: GraphColumns, b: GraphColumns): boolean {
  return (
    a.order.length === b.order.length &&
    a.order.every((id, index) => id === b.order[index]) &&
    a.hidden.length === b.hidden.length &&
    a.hidden.every((id, index) => id === b.hidden[index])
  );
}

/** The columns are as they come. */
export function isDefaultColumns(columns: GraphColumns): boolean {
  return sameColumns(columns, DEFAULT_COLUMNS);
}

/** Switches a column on or off (the message always shows). */
export function toggleColumn(columns: GraphColumns, id: ColumnId): GraphColumns {
  if (id === 'message') return columns;
  const off = !columns.hidden.includes(id);
  return {
    order: columns.order,
    hidden: COLUMN_IDS.filter((other) => (other === id ? off : columns.hidden.includes(other))),
  };
}

/** Moves a column to just before another one (`before` undefined: to the end). */
export function moveColumn(columns: GraphColumns, id: ColumnId, before: ColumnId | undefined): GraphColumns {
  if (id === before) return columns;
  const rest = columns.order.filter((other) => other !== id);
  const at = before === undefined ? rest.length : rest.indexOf(before);
  if (at < 0) return columns;
  const order = [...rest.slice(0, at), id, ...rest.slice(at)];
  return order.every((other, index) => other === columns.order[index]) ? columns : { ...columns, order };
}

/**
 * Moves a column past its neighbour on screen, to the left (-1) or right (1); `visible`: the
 * columns on screen, in order. Undefined when it is the first or last column already.
 */
export function shiftColumn(
  columns: GraphColumns,
  id: ColumnId,
  direction: -1 | 1,
  visible: readonly ColumnId[],
): GraphColumns | undefined {
  const index = visible.indexOf(id);
  const neighbour = index < 0 ? undefined : visible[index + direction];
  if (!neighbour) return undefined;
  if (direction < 0) return moveColumn(columns, id, neighbour);
  // To the right: before whatever follows the neighbour (columns switched off keep their places).
  const rest = columns.order.filter((other) => other !== id);
  return moveColumn(columns, id, rest[rest.indexOf(neighbour) + 1]);
}

/**
 * The columns a graph `width` px wide leaves out for want of room, so that the message keeps
 * about 300px: the counts of lines and files first, then the hash, then the author.
 */
export function droppedColumns(columns: GraphColumns, width: number): ReadonlySet<ColumnId> {
  const dropped = new Set<ColumnId>();
  const taken = () =>
    COLUMN_IDS.reduce(
      (sum, id) =>
        id === 'message' || columns.hidden.includes(id) || dropped.has(id) ? sum : sum + COLUMN_WIDTHS[id],
      0,
    );
  for (const id of DROPPED_FIRST) {
    if (columns.hidden.includes(id)) continue;
    if (width >= taken() + MESSAGE_ROOM) break;
    dropped.add(id);
  }
  return dropped;
}

/** The columns on screen, in order: those switched on that the graph has room for. */
export function visibleColumns(columns: GraphColumns, dropped: ReadonlySet<ColumnId>): ColumnId[] {
  return columns.order.filter((id) => !columns.hidden.includes(id) && !dropped.has(id));
}

/** The CSS grid tracks of the lanes and the columns on screen. */
export function gridTemplate(visible: readonly ColumnId[]): string {
  return [
    'var(--lf-col-graph)',
    ...visible.map((id) => (id === 'message' ? 'minmax(0, 1fr)' : `${COLUMN_WIDTHS[id]}px`)),
  ].join(' ');
}
