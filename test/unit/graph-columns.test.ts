import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMNS,
  droppedColumns,
  gridTemplate,
  isDefaultColumns,
  moveColumn,
  parseColumns,
  shiftColumn,
  toggleColumn,
  visibleColumns,
  type GraphColumns,
} from '../../src/webview/graph/columns';

const columns = (order: GraphColumns['order'], hidden: GraphColumns['hidden'] = []): GraphColumns => ({
  order,
  hidden,
});

describe('stored columns', () => {
  it('gives the usual columns for anything unusable', () => {
    for (const value of [undefined, null, 'author', 42, {}, { order: 'message' }, { hidden: ['author'] }])
      expect(parseColumns(value)).toEqual(DEFAULT_COLUMNS);
  });

  it('keeps what is valid: known columns once, the message always shown', () => {
    expect(
      parseColumns({
        order: ['sha', 'nope', 'date', 'sha', 7, 'message', 'author'],
        hidden: ['message', 'author', 'bogus'],
      }),
    ).toEqual(columns(['sha', 'date', 'message', 'author'], ['author']));
  });

  it('puts the columns it does not name (newer ones) last, shown', () => {
    expect(parseColumns({ order: ['date', 'message'], hidden: ['date'] })).toEqual(
      columns(['date', 'message', 'author', 'sha'], ['date']),
    );
  });

  it('lists hidden columns in their usual order', () => {
    expect(parseColumns({ order: DEFAULT_COLUMNS.order, hidden: ['sha', 'author'] }).hidden).toEqual([
      'author',
      'sha',
    ]);
  });
});

describe('switching columns on and off', () => {
  it('switches a column off and on again', () => {
    const off = toggleColumn(DEFAULT_COLUMNS, 'date');
    expect(off).toEqual(columns(DEFAULT_COLUMNS.order, ['date']));
    expect(toggleColumn(off, 'date')).toEqual(DEFAULT_COLUMNS);
    expect(toggleColumn(toggleColumn(off, 'sha'), 'author').hidden).toEqual(['author', 'date', 'sha']);
  });

  it('never switches the message off', () => {
    expect(toggleColumn(DEFAULT_COLUMNS, 'message')).toBe(DEFAULT_COLUMNS);
  });

  it('knows the usual columns', () => {
    expect(isDefaultColumns(DEFAULT_COLUMNS)).toBe(true);
    expect(isDefaultColumns(parseColumns(JSON.parse(JSON.stringify(DEFAULT_COLUMNS))))).toBe(true);
    expect(isDefaultColumns(toggleColumn(DEFAULT_COLUMNS, 'sha'))).toBe(false);
    expect(isDefaultColumns(moveColumn(DEFAULT_COLUMNS, 'date', 'author'))).toBe(false);
  });
});

describe('moving columns', () => {
  it('moves a column before another, or to the end', () => {
    expect(moveColumn(DEFAULT_COLUMNS, 'date', 'author').order).toEqual(['message', 'date', 'author', 'sha']);
    expect(moveColumn(DEFAULT_COLUMNS, 'sha', 'message').order).toEqual(['sha', 'message', 'author', 'date']);
    expect(moveColumn(DEFAULT_COLUMNS, 'message', undefined).order).toEqual([
      'author',
      'date',
      'sha',
      'message',
    ]);
  });

  it('leaves the columns as they are when nothing moves', () => {
    expect(moveColumn(DEFAULT_COLUMNS, 'author', 'author')).toBe(DEFAULT_COLUMNS);
    expect(moveColumn(DEFAULT_COLUMNS, 'author', 'date')).toBe(DEFAULT_COLUMNS);
    expect(moveColumn(DEFAULT_COLUMNS, 'sha', undefined)).toBe(DEFAULT_COLUMNS);
  });

  it('moves a column past its neighbour on screen', () => {
    const all = visibleColumns(DEFAULT_COLUMNS, new Set());
    expect(shiftColumn(DEFAULT_COLUMNS, 'date', -1, all)?.order).toEqual([
      'message',
      'date',
      'author',
      'sha',
    ]);
    expect(shiftColumn(DEFAULT_COLUMNS, 'message', 1, all)?.order).toEqual([
      'author',
      'message',
      'date',
      'sha',
    ]);
    expect(shiftColumn(DEFAULT_COLUMNS, 'message', -1, all)).toBeUndefined();
    expect(shiftColumn(DEFAULT_COLUMNS, 'sha', 1, all)).toBeUndefined();
  });

  it('steps over the columns switched off, which keep their places', () => {
    const noAuthor = toggleColumn(DEFAULT_COLUMNS, 'author');
    const shown = visibleColumns(noAuthor, new Set());
    expect(shown).toEqual(['message', 'date', 'sha']);
    // Date goes left of the message; the author, off, stays between them.
    expect(shiftColumn(noAuthor, 'date', -1, shown)?.order).toEqual(['date', 'message', 'author', 'sha']);
    // The message goes right of the date.
    expect(shiftColumn(noAuthor, 'message', 1, shown)?.order).toEqual(['author', 'date', 'message', 'sha']);
  });

  it('cannot move a column that is not on screen', () => {
    const shown = visibleColumns(DEFAULT_COLUMNS, new Set(['sha'] as const));
    expect(shiftColumn(DEFAULT_COLUMNS, 'sha', -1, shown)).toBeUndefined();
  });
});

describe('a narrow graph', () => {
  it('leaves out the hash, then the author, to keep room for the message', () => {
    expect([...droppedColumns(DEFAULT_COLUMNS, 1200)]).toEqual([]);
    expect([...droppedColumns(DEFAULT_COLUMNS, 720)]).toEqual([]);
    expect([...droppedColumns(DEFAULT_COLUMNS, 719)]).toEqual(['sha']);
    expect([...droppedColumns(DEFAULT_COLUMNS, 640)]).toEqual(['sha']);
    expect([...droppedColumns(DEFAULT_COLUMNS, 600)]).toEqual(['sha', 'author']);
    // The date stays, however narrow.
    expect([...droppedColumns(DEFAULT_COLUMNS, 0)]).toEqual(['sha', 'author']);
  });

  it('has room for more when columns are switched off', () => {
    // Without the author, the hash fits where it otherwise would not.
    expect([...droppedColumns(toggleColumn(DEFAULT_COLUMNS, 'author'), 600)]).toEqual([]);
    expect([...droppedColumns(toggleColumn(DEFAULT_COLUMNS, 'sha'), 640)]).toEqual([]);
    expect([...droppedColumns(toggleColumn(DEFAULT_COLUMNS, 'sha'), 600)]).toEqual(['author']);
  });

  it('shows the columns switched on that it has room for, in their order', () => {
    const arranged = columns(['sha', 'message', 'date', 'author'], ['date']);
    expect(visibleColumns(arranged, new Set())).toEqual(['sha', 'message', 'author']);
    expect(visibleColumns(arranged, droppedColumns(arranged, 500))).toEqual(['message']);
  });
});

describe('grid tracks', () => {
  it('are the lanes, then each column on screen', () => {
    expect(gridTemplate(['message', 'author', 'date', 'sha'])).toBe(
      'var(--lf-col-graph) minmax(0, 1fr) 168px 104px 84px',
    );
    expect(gridTemplate(['date', 'message'])).toBe('var(--lf-col-graph) 104px minmax(0, 1fr)');
  });
});
