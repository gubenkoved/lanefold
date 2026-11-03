import type { AnimationLevel, Density, RefInfo } from '../../shared/models';
import {
  COLUMN_HEADINGS,
  COLUMN_IDS,
  COLUMN_WIDTHS,
  droppedColumns,
  gridTemplate,
  isColumnId,
  moveColumn,
  shiftColumn,
  visibleColumns,
  type ColumnId,
  type GraphColumns,
} from './columns';
import { absoluteTime, initials, relativeTime, shortSha, stringHash } from './format';
import type { LogModel, RowSource } from './logModel';
import { recentRenames } from './renames';
import { paintGraph, RowFlag } from './painter';
import { avatarColor, luminance, type Palette } from './palette';
import { laneColors, repoColor } from './repoColors';
import styles from './GraphView.module.css';
import { mark } from '../perf';

export interface GraphViewCallbacks {
  /** Selection changed (SHAs in row order) and the focused commit. */
  onSelectionChange(shas: readonly string[], focused: string | undefined): void;
  onContextMenu(row: number, clientX: number, clientY: number): void;
  /** Double click / Enter on a row. */
  onOpen(row: number): void;
  /** Pointer rests on a row (undefined when it leaves). */
  onHover(row: number | undefined, rect: DOMRect | undefined): void;
  onRefClick?(ref: RefInfo, event: MouseEvent): void;
  /** A branch/tag pill or the selected commits were dropped on a row. */
  onDrop?(item: DragItem, targetRow: number, clientX: number, clientY: number): void;
  /**
   * The column headings' menu, opened on a heading (`column`) or on the lanes' (undefined).
   * `visible`: the columns on screen; `dropped`: those a narrow graph leaves out.
   */
  onColumnsMenu?(
    column: ColumnId | undefined,
    anchor: Element | { readonly x: number; readonly y: number },
    context: { readonly visible: readonly ColumnId[]; readonly dropped: ReadonlySet<ColumnId> },
  ): void;
  /** The columns were rearranged here: a heading dragged, or moved from the keyboard. */
  onColumnsChange?(columns: GraphColumns): void;
}

/** What can be dragged in the graph: a ref pill, the selected commits, or the uncommitted changes. */
export type DragItem =
  | { readonly kind: 'ref'; readonly ref: RefInfo }
  | { readonly kind: 'commits'; readonly shas: readonly string[] }
  | { readonly kind: 'changes' };

interface DragState {
  readonly item: DragItem;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Row pressed (a commit press without movement selects just that row). */
  readonly pressRow: number;
  active: boolean;
  ghost?: HTMLElement;
  stop: () => void;
}

/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

export interface GraphViewOptions {
  readonly density: Density;
  readonly curved: boolean;
  readonly palette: Palette;
  readonly animations: AnimationLevel;
  /** Which columns show, in what order (the person's choice; a narrow graph shows fewer). */
  readonly columns: GraphColumns;
}

/** A status chip on a commit's row. */
export interface RowMark {
  readonly label: string;
  /** A codicon. */
  readonly icon: string;
  readonly tone: 'done' | 'current' | 'pending' | 'good' | 'bad' | 'muted';
  readonly title?: string;
}

export interface Highlight {
  readonly shas: ReadonlySet<string>;
  /** 'highlight' dims non-matching rows; 'filter' is handled by the model. */
  readonly mode: 'highlight';
}

/** What the graph says when it has no rows, in place of its own words (a search matching nothing). */
export interface EmptyNote {
  readonly title: string;
  readonly detail: string;
  /** Buttons under the words; the first is the main one. */
  readonly actions?: readonly { readonly label: string; readonly run: () => void }[];
}

const ROW_HEIGHT: Record<Density, number> = { compact: 22, comfortable: 26, spacious: 30 };
const LANE_WIDTH: Record<Density, number> = { compact: 12, comfortable: 14, spacious: 16 };
const GRAPH_PADDING = 10;
const TRANSITION_MS = 280;

let graphCounter = 0;

interface Slot {
  readonly el: HTMLDivElement;
  readonly graph: HTMLDivElement;
  /** The stripe naming the row's repository (logs of several repositories), made on first use. */
  marker?: HTMLSpanElement;
  readonly refs: HTMLSpanElement;
  readonly subject: HTMLSpanElement;
  readonly avatar: HTMLSpanElement;
  readonly authorName: HTMLSpanElement;
  readonly date: HTMLDivElement;
  readonly sha: HTMLDivElement;
  /** The cells of the columns after the lanes (reordered with the columns). */
  readonly cells: Readonly<Record<ColumnId, HTMLDivElement>>;
  row: number;
  /** What the slot currently shows (it is refilled when any of these change). */
  shownSha: string;
  shownMeta: boolean;
  shownVersion: number;
  stateKey: number;
  y: number;
  opacity: string;
}

interface Transition {
  readonly start: number;
  /** Previous on-screen position of commits that were visible (sha → x, y in viewport space). */
  readonly from: ReadonlyMap<string, { x: number; y: number }>;
  readonly mode: 'move' | 'fade';
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * JavaScript time spent per rendered frame (ring buffer), read by performance tests through
 * `globalThis.__lanefoldPerf`. Costs two `performance.now()` calls per frame.
 */
const frameTimes = { samples: new Float32Array(2048), count: 0 };
(globalThis as { __lanefoldPerf?: unknown }).__lanefoldPerf = {
  frameTimes: () =>
    Array.from(frameTimes.samples.subarray(0, Math.min(frameTimes.count, frameTimes.samples.length))),
  reset: () => (frameTimes.count = 0),
};

/**
 * The commit graph: an imperative, virtualized view that owns its scroll position, recycles a
 * small pool of row elements and paints lanes on a canvas — all in the same animation frame, so
 * text and graph never drift apart and React never re-renders while scrolling.
 */
export class GraphView {
  readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly headerCells: Readonly<Record<ColumnId, HTMLDivElement>>;
  /** Where a dragged column heading would go: a line between two columns. */
  private readonly columnDrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rowsLayer: HTMLDivElement;
  private readonly ghostLayer: HTMLDivElement;
  private readonly scrollbar: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly markers: HTMLCanvasElement;
  private readonly status: HTMLDivElement;
  /** Why the graph is empty (no commits yet, nothing in this view). */
  private readonly emptyNote: HTMLDivElement;
  private readonly emptyTitle: HTMLDivElement;
  private readonly emptyText: HTMLDivElement;
  private readonly emptyActions: HTMLDivElement;
  private emptyOverride: EmptyNote | undefined;
  private readonly slots: Slot[] = [];
  private readonly resizeObserver: ResizeObserver;

  private model: LogModel | undefined;
  private unsubscribeModel: (() => void) | undefined;
  private options: GraphViewOptions;
  private rowHeight: number;
  private laneWidth: number;

  private scrollTop = 0;
  private scrollTarget = 0;
  private viewportHeight = 0;
  private viewportWidth = 0;
  private graphWidth = 48;
  /** The graph width ref pills were last fitted for. */
  private fittedGraphWidth = 48;
  private graphShrinkAt = 0;
  private frame = 0;
  private scrollingTimer: ReturnType<typeof setTimeout> | undefined;

  /** Selected commits (sha → row in the current model). */
  private selected = new Map<string, number>();
  private anchorRow = -1;
  private background = '#1f1f1f';
  private accent = '#0078d4';
  private findMatch = 'rgba(209, 134, 22, 0.8)';
  private focusRow = 0;
  /** Prefix of row element ids (for aria-activedescendant: focus stays on the grid itself). */
  private readonly idPrefix = `lf-graph-${++graphCounter}`;
  private activeDescendant = '';
  private hoverRow = -1;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private dragSelect: { pointerId: number; startRow: number } | undefined;
  private autoScroll = 0;
  private highlight: Highlight | undefined;
  private contentVersion = 0;
  /** Ref pills shown on a row before the rest collapse into "+N" (fewer in narrow panels). */
  private pillLimit = 4;
  private markersKey = '';
  private pendingAnchor: { sha: string; offset: number } | undefined;
  private transition: Transition | undefined;
  /** Colors by lane color index (repositories' included), and the same in RGB. */
  private colors: readonly string[] = [];
  private rgb: readonly (readonly [number, number, number])[] = [];
  private disposed = false;
  private drag: DragState | undefined;
  private dropRow = -1;
  /** Swallows the click that follows a drop on a pill. */
  private suppressClick = false;
  private paintedRows = false;
  /** The columns on screen, in order, and those a narrow graph leaves out (see applyColumns). */
  private visible: readonly ColumnId[] = [];
  private dropped: ReadonlySet<ColumnId> = new Set();
  /** The order the cells are in (the DOM follows the screen, for screen readers). */
  private cellOrder = '';
  /** The heading Tab reaches: the arrow keys move between them. */
  private headerFocus: ColumnId = 'message';
  /** A column heading being dragged sideways. */
  private columnDrag: { readonly stop: () => void } | undefined;

  constructor(
    container: HTMLElement,
    private readonly callbacks: GraphViewCallbacks,
    options: GraphViewOptions,
  ) {
    this.options = options;
    this.rowHeight = ROW_HEIGHT[options.density];
    this.laneWidth = LANE_WIDTH[options.density];

    this.root = el('div', styles.root!);
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', 'Commit graph');
    this.root.setAttribute('aria-multiselectable', 'true');

    this.header = el('div', styles.header!);
    this.header.setAttribute('role', 'row');
    const heading = (column: ColumnId | 'graph') => {
      const cell = el('div', styles.headerCell!);
      cell.setAttribute('role', 'columnheader');
      cell.dataset.column = column;
      if (column === 'graph') return cell;
      cell.textContent = COLUMN_HEADINGS[column];
      cell.title = 'Drag to move (Alt+←/→); right-click to choose the columns';
      cell.tabIndex = -1;
      return cell;
    };
    this.header.append(heading('graph'));
    this.headerCells = {
      message: heading('message'),
      author: heading('author'),
      date: heading('date'),
      sha: heading('sha'),
    };
    this.header.append(...options.columns.order.map((id) => this.headerCells[id]));
    this.setHeaderFocus('message');
    this.columnDrop = el('div', styles.columnDrop!);
    this.columnDrop.hidden = true;

    this.body = el('div', styles.body!);
    this.canvas = el('canvas', styles.canvas!);
    this.ctx = this.canvas.getContext('2d')!;
    this.rowsLayer = el('div', styles.rows!);
    this.rowsLayer.setAttribute('role', 'rowgroup');
    this.ghostLayer = el('div', styles.ghosts!);
    this.scrollbar = el('div', styles.scrollbar!);
    this.markers = el('canvas', styles.markers!);
    this.thumb = el('div', styles.thumb!);
    this.scrollbar.append(this.markers, this.thumb);
    this.status = el('div', styles.status!);
    this.status.hidden = true;
    this.emptyNote = el('div', styles.emptyNote!);
    this.emptyNote.hidden = true;
    this.emptyTitle = el('div', styles.emptyTitle!);
    this.emptyText = el('div', styles.emptyText!);
    this.emptyActions = el('div', styles.emptyActions!);
    this.emptyActions.hidden = true;
    this.emptyNote.append(this.emptyTitle, this.emptyText, this.emptyActions);
    this.body.append(
      this.rowsLayer,
      this.ghostLayer,
      this.canvas,
      this.scrollbar,
      this.status,
      this.emptyNote,
    );
    this.root.append(this.header, this.body, this.columnDrop);
    container.append(this.root);

    this.applyDensity();
    this.updateColors();
    this.attachEvents();
    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(this.body);
    this.measure();
  }

  // ---- public API --------------------------------------------------------------------------

  setModel(model: LogModel | undefined, options: { animate?: boolean } = {}): void {
    const previous = this.model;
    if (previous === model) return;
    // Commits just rewritten by a history edit, as far as this graph showed them.
    const renames =
      previous && model && previous.repoId === model.repoId
        ? this.renamesFrom(previous, model.repoId)
        : undefined;
    const renamed = (sha: string) => renames?.get(sha) ?? sha;
    // Keep the commit at the top (or the focused one) at the same place on screen. A view at
    // the very top stays there: new commits (a commit, a pull) come into view above the others.
    if (previous && model) {
      const anchorRow = this.focusRowVisible() ? this.focusRow : Math.floor(this.scrollTop / this.rowHeight);
      if (this.scrollTop > 0 && anchorRow < previous.rowCount) {
        this.pendingAnchor = {
          sha: renamed(previous.sha(anchorRow)),
          offset: anchorRow * this.rowHeight - this.scrollTop,
        };
      }
      if (options.animate && this.options.animations !== 'off') this.beginTransition(previous, renames);
    } else {
      this.scrollTop = this.scrollTarget = 0;
      this.focusRow = 0;
    }
    this.unsubscribeModel?.();
    this.model = model;
    this.unsubscribeModel = model?.subscribe(() => this.onModelChange());
    this.pendingSelection =
      this.selected.size > 0 ? [...new Set([...this.selected.keys()].map(renamed))] : undefined;
    this.selectionRenamed = !!renames && [...this.selected.keys()].some((sha) => renames.has(sha));
    if (renames && renames.size > 0) this.flash(new Set(renames.values()));
    for (const slot of this.slots) slot.shownSha = '';
    this.contentVersion++;
    this.markersKey = '';
    this.invalidate();
  }

  /** The rewrites (old → new commit) that concern commits `previous` holds. */
  private renamesFrom(previous: LogModel, repoId: string): ReadonlyMap<string, string> | undefined {
    const all = recentRenames(repoId);
    if (!all) return undefined;
    const relevant = new Map<string, string>();
    for (const [from, to] of all) if (from !== to && previous.rowOf(from) >= 0) relevant.set(from, to);
    return relevant.size > 0 ? relevant : undefined;
  }

  private flashing: ReadonlySet<string> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  /** Makes the rows of these commits glow briefly (e.g. the result of a history edit). */
  flash(shas: ReadonlySet<string>): void {
    if (this.options.animations === 'off') return;
    this.flashing = shas;
    this.contentVersion++;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashing = undefined;
      this.contentVersion++;
      this.invalidate();
    }, 1800);
    this.invalidate();
  }

  /** Selection carried over from a previous model; re-resolved once rows have streamed in. */
  private pendingSelection: string[] | undefined;
  /** The carried-over selection follows rewritten commits (listeners must hear about it). */
  private selectionRenamed = false;

  private resolvePendingSelection(model: LogModel): void {
    if (!this.pendingSelection || model.rowCount === 0) return;
    const rows = model.rowsOf(this.pendingSelection);
    if (rows.size === this.pendingSelection.length || model.phase === 'ready') {
      const lost = rows.size !== this.pendingSelection.length;
      this.selected = rows;
      this.pendingSelection = undefined;
      if (rows.size > 0) this.focusRow = this.anchorRow = Math.min(...rows.values());
      else this.focusRow = Math.min(this.focusRow, Math.max(0, model.rowCount - 1));
      this.markersKey = '';
      // Commits that vanished (amended, rebased, filtered out) leave the selection; rewritten
      // ones are replaced by what they became.
      if (lost || this.selectionRenamed) queueMicrotask(() => this.emitSelection());
      this.selectionRenamed = false;
    }
  }

  setOptions(options: GraphViewOptions): void {
    const densityChanged = options.density !== this.options.density;
    const columnsChanged = options.columns !== this.options.columns;
    this.options = options;
    if (densityChanged) {
      const topRow = this.scrollTop / this.rowHeight;
      this.rowHeight = ROW_HEIGHT[options.density];
      this.laneWidth = LANE_WIDTH[options.density];
      this.applyDensity();
      this.scrollTop = this.scrollTarget = topRow * this.rowHeight;
    }
    if (columnsChanged) this.applyColumns();
    this.updateColors();
    this.contentVersion++;
    this.markersKey = '';
    this.invalidate();
  }

  /** Status chips on commits (a rebase's progress, bisect verdicts), keyed by object ID. */
  setMarks(marks: ReadonlyMap<string, RowMark> | undefined): void {
    if (marks === this.marks) return;
    this.marks = marks;
    this.contentVersion++;
    this.invalidate();
  }

  private marks: ReadonlyMap<string, RowMark> | undefined;

  setHighlight(highlight: Highlight | undefined): void {
    this.highlight = highlight;
    this.highlightRows = highlight && this.model ? this.model.rowsOf(highlight.shas) : undefined;
    this.contentVersion++;
    this.markersKey = '';
    this.invalidate();
  }

  /** What to say, and offer, when there are no rows (undefined: the graph's own words). */
  setEmptyNote(note: EmptyNote | undefined): void {
    const words = (n: EmptyNote | undefined) =>
      n ? [n.title, n.detail, ...(n.actions ?? []).map((action) => action.label)].join('\n') : '';
    const changed = words(note) !== words(this.emptyOverride);
    // The buttons call the latest handlers, also when the words stay the same.
    this.emptyOverride = note;
    if (!changed) return;
    this.emptyActions.replaceChildren(
      ...(note?.actions ?? []).map((action, index) => {
        const button = el('button', `${styles.emptyAction} ${index === 0 ? styles.emptyActionMain : ''}`);
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', () => this.emptyOverride?.actions?.[index]?.run());
        return button;
      }),
    );
    this.invalidate();
  }

  /** Rows of the current highlight matches, top to bottom (for "next match" navigation). */
  get highlightedRows(): number[] {
    return this.highlightRows ? [...this.highlightRows.values()].sort((a, b) => a - b) : [];
  }

  /** Selects commits by SHA (e.g. restoring a selection after a refresh). */
  setSelection(shas: readonly string[], focusSha?: string): void {
    if (!this.model) return;
    this.selected = this.model.rowsOf(shas);
    if (focusSha) {
      const row = this.selected.get(focusSha) ?? this.model.rowOf(focusSha);
      if (row >= 0) this.focusRow = this.anchorRow = row;
    }
    this.markersKey = '';
    this.invalidate();
  }

  get selection(): readonly string[] {
    return [...this.selected.keys()];
  }

  /** The first row in view (for keeping the reading position across reloads). */
  get topRow(): number {
    return Math.floor(this.scrollTop / this.rowHeight);
  }

  /** Selects one row and scrolls it into view (e.g. stepping through search matches). */
  selectRow(row: number, align: 'nearest' | 'center' = 'center'): void {
    if (!this.model || row < 0) return;
    // A row far below may not be laid out yet (a filtered history lays itself out in the background).
    this.model.ensureLayout(row);
    if (row >= this.model.rowCount) return;
    this.selectSingle(row);
    this.revealRow(row, align);
  }

  /** Scrolls a row into view without changing the selection. */
  showRow(row: number): void {
    if (!this.model || row < 0) return;
    this.model.ensureLayout(row);
    this.revealRow(row, 'center');
  }

  /** Scrolls so `row` is visible ('center' puts it in the middle). */
  revealRow(row: number, align: 'nearest' | 'center' = 'nearest', smooth = true): void {
    const h = this.rowHeight;
    const top = row * h;
    let target = this.scrollTarget;
    if (align === 'center') target = top - (this.viewportHeight - h) / 2;
    else if (top < this.scrollTarget) target = top;
    else if (top + h > this.scrollTarget + this.viewportHeight) target = top + h - this.viewportHeight;
    this.scrollTo(target, smooth && this.options.animations !== 'off');
  }

  /** Focuses, selects and reveals a commit. Returns false if it is not loaded. */
  goTo(sha: string): boolean {
    if (!this.model) return false;
    const row = this.model.rowOf(sha);
    if (row < 0) return false;
    this.selectSingle(row);
    this.revealRow(row, 'center');
    return true;
  }

  focus(): void {
    this.root.focus({ preventScroll: true });
  }

  rowRect(row: number): DOMRect | undefined {
    const slot = this.slots.find((s) => s.row === row && !s.el.hidden);
    return slot?.el.getBoundingClientRect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.drag?.stop();
    this.columnDrag?.stop();
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.unsubscribeModel?.();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.root.remove();
  }

  // ---- layout & rendering ------------------------------------------------------------------

  private applyDensity(): void {
    this.root.style.setProperty('--lf-row-h', `${this.rowHeight}px`);
  }

  /** Palette and theme colors used while painting; refreshed on theme/option changes only. */
  private updateColors(): void {
    const colors = laneColors(this.options.palette);
    this.colors = colors.css;
    this.rgb = colors.rgb;
    const style = getComputedStyle(this.root);
    this.background = style.getPropertyValue('--lf-bg').trim() || this.background;
    this.accent = style.getPropertyValue('--lf-focus').trim() || this.accent;
    this.findMatch =
      style.getPropertyValue('--vscode-editorOverviewRuler-findMatchForeground').trim() || this.findMatch;
  }

  private measure(): void {
    const rect = this.body.getBoundingClientRect();
    this.viewportHeight = rect.height;
    this.viewportWidth = rect.width;
    // Narrow panels drop the least important columns; messages keep about 300px.
    this.applyColumns();
    // Fewer, whole pills read better than many squeezed ones.
    const pillLimit = this.viewportWidth < 480 ? 2 : this.viewportWidth < 800 ? 3 : 4;
    if (pillLimit !== this.pillLimit) {
      this.pillLimit = pillLimit;
      this.contentVersion++;
    }
    this.invalidate();
  }

  /**
   * Shows the columns switched on that the graph has room for, in the person's order: the grid's
   * tracks, the cells that take no place, and the cells' order in the DOM (headings and rows),
   * which follows the screen's for screen readers.
   */
  private applyColumns(): void {
    const columns = this.options.columns;
    this.dropped = droppedColumns(columns, this.viewportWidth);
    const visible = visibleColumns(columns, this.dropped);
    if (visible.join() !== this.visible.join()) {
      this.visible = visible;
      for (const id of COLUMN_IDS) this.root.toggleAttribute(`data-no-${id}`, !visible.includes(id));
      this.root.style.setProperty('--lf-cols', gridTemplate(visible));
      // Tab reaches a heading on screen.
      if (!visible.includes(this.headerFocus)) this.setHeaderFocus(visible[0] ?? 'message');
      // Ref pills are fitted to the message column's room.
      this.contentVersion++;
      this.invalidate();
    }
    const order = columns.order.join();
    if (order === this.cellOrder) return;
    this.cellOrder = order;
    const focused = document.activeElement;
    this.header.append(...columns.order.map((id) => this.headerCells[id]));
    for (const slot of this.slots) slot.el.append(...columns.order.map((id) => slot.cells[id]));
    // A heading moved from the keyboard lost focus as it moved: it keeps it.
    if (focused instanceof HTMLElement && focused !== document.activeElement && this.header.contains(focused))
      focused.focus({ preventScroll: true });
  }

  /** Makes a column's heading the one Tab reaches. */
  private setHeaderFocus(id: ColumnId): void {
    this.headerFocus = id;
    for (const column of COLUMN_IDS) this.headerCells[column].tabIndex = column === id ? 0 : -1;
  }

  private onModelChange(): void {
    this.contentVersion++;
    this.invalidate();
  }

  invalidate(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private get maxScroll(): number {
    return Math.max(0, (this.model?.rowCount ?? 0) * this.rowHeight - this.viewportHeight);
  }

  private scrollTo(target: number, smooth: boolean): void {
    this.scrollTarget = Math.min(Math.max(0, target), this.maxScroll);
    if (!smooth) this.scrollTop = this.scrollTarget;
    // A long way (Home, End, a search match far off): jump most of it, glide the last screen.
    else if (Math.abs(this.scrollTarget - this.scrollTop) > this.viewportHeight * 2)
      this.scrollTop =
        this.scrollTarget - Math.sign(this.scrollTarget - this.scrollTop) * this.viewportHeight;
    this.markScrolling();
    this.invalidate();
  }

  private markScrolling(): void {
    this.root.classList.add(styles.scrolling!);
    if (this.scrollingTimer) clearTimeout(this.scrollingTimer);
    this.scrollingTimer = setTimeout(() => this.root.classList.remove(styles.scrolling!), 900);
  }

  private focusRowVisible(): boolean {
    const top = this.focusRow * this.rowHeight;
    return top >= this.scrollTop && top < this.scrollTop + this.viewportHeight;
  }

  private render(): void {
    const started = performance.now();
    this.renderFrame();
    frameTimes.samples[frameTimes.count++ % frameTimes.samples.length] = performance.now() - started;
  }

  private renderFrame(): void {
    const model = this.model;
    const h = this.rowHeight;
    let animating = false;

    // Smooth scrolling: approach the target exponentially (frame-rate independent enough here).
    if (Math.abs(this.scrollTarget - this.scrollTop) > 0.5) {
      this.scrollTop += (this.scrollTarget - this.scrollTop) * 0.32;
      animating = true;
    } else this.scrollTop = this.scrollTarget;

    if (!model) {
      for (const slot of this.slots) slot.el.hidden = true;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    this.resolvePendingSelection(model);
    // Resolve a scroll anchor carried over from the previous model.
    if (this.pendingAnchor && model.rowCount > 0) {
      const row = model.rowOf(this.pendingAnchor.sha);
      if (row >= 0) {
        this.scrollTop = this.scrollTarget = Math.max(0, row * h - this.pendingAnchor.offset);
        this.pendingAnchor = undefined;
      } else if (model.phase === 'ready') this.pendingAnchor = undefined;
    }

    // Lay out what is in view right away; background slices take care of the rest.
    model.ensureLayout(Math.floor((this.scrollTop + this.viewportHeight) / h) + 1);
    const rows = model.rowCount;
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, rows * h - this.viewportHeight));
    const first = Math.max(0, Math.floor(this.scrollTop / h));
    const last = Math.min(rows - 1, Math.floor((this.scrollTop + this.viewportHeight) / h));
    if (last >= 0) {
      model.ensureLayout(last + 1);
      model.requestMeta(first, last);
    }

    animating = this.updateGraphWidth(first, last) || animating;
    const transitionT = this.transitionProgress();
    if (transitionT < 1) animating = true;

    this.prepareFrame(model, first, last);
    if (!this.paintedRows && last >= first && last >= 0) {
      this.paintedRows = true;
      mark(`first-rows:${model.id}`);
    }
    this.renderRows(model, first, last, transitionT);
    this.paint(model, first, last, transitionT);
    this.renderScrollbar(model);
    this.renderStatus(model);

    this.root.setAttribute('aria-rowcount', String(rows));
    if (animating || this.autoScroll !== 0) {
      if (this.autoScroll !== 0) this.applyAutoScroll();
      this.invalidate();
    }
  }

  /** Graph column width follows the lanes in view: grows at once, shrinks after a pause. */
  private updateGraphWidth(first: number, last: number): boolean {
    const model = this.model!;
    const lanes = last >= first ? model.layout.lanesInRange(first, last) : 1;
    const target = Math.min(
      Math.max(36, GRAPH_PADDING * 2 + lanes * this.laneWidth),
      Math.max(120, this.viewportWidth * 0.45),
    );
    const now = performance.now();
    let width = this.graphWidth;
    if (target > width) {
      width = this.options.animations === 'off' ? target : width + (target - width) * 0.35;
      this.graphShrinkAt = now + 500;
    } else if (target < width && now >= this.graphShrinkAt) {
      width = this.options.animations === 'off' ? target : width + (target - width) * 0.2;
    }
    if (Math.abs(width - target) < 0.5) width = target;
    if (
      Math.abs(width - this.graphWidth) >= 0.25 ||
      this.root.style.getPropertyValue('--lf-col-graph') === ''
    ) {
      this.graphWidth = width;
      this.root.style.setProperty('--lf-col-graph', `${Math.round(width)}px`);
    }
    // Ref pills are fitted to the room the graph leaves: refit once it settles elsewhere.
    if (width === target && Math.abs(target - this.fittedGraphWidth) >= 16) {
      this.fittedGraphWidth = target;
      this.contentVersion++;
    }
    return width !== target || (target < width && now < this.graphShrinkAt);
  }

  private transitionProgress(): number {
    if (!this.transition) return 1;
    const t = (performance.now() - this.transition.start) / TRANSITION_MS;
    if (t >= 1) {
      this.transition = undefined;
      this.ghostLayer.replaceChildren();
      return 1;
    }
    return easeOutCubic(Math.max(0, t));
  }

  private beginTransition(previous: LogModel, renames?: ReadonlyMap<string, string>): void {
    const from = new Map<string, { x: number; y: number }>();
    const h = this.rowHeight;
    const first = Math.floor(this.scrollTop / h);
    const last = Math.min(previous.rowCount - 1, first + Math.ceil(this.viewportHeight / h));
    const ghosts: HTMLElement[] = [];
    for (let row = first; row <= last; row++) {
      const sha = previous.sha(row);
      const y = row * h - this.scrollTop;
      const position = { x: this.laneX(previous.layout.nodeLane[row] ?? 0), y };
      from.set(sha, position);
      // A rewritten commit starts where its original was; for a squash that is the oldest of the
      // group (the lowest row), so the others fold down into it.
      const renamed = renames?.get(sha);
      if (renamed) from.set(renamed, position);
      const slot = this.slots.find((s) => s.row === row && !s.el.hidden);
      if (slot) {
        const ghost = slot.el.cloneNode(true) as HTMLDivElement;
        ghost.dataset.sha = sha;
        ghost.dataset.y = String(y);
        if (renamed) ghost.dataset.renamed = renamed;
        ghost.style.transform = `translateY(${y}px)`;
        ghosts.push(ghost);
      }
    }
    this.ghostLayer.replaceChildren(...ghosts);
    this.transition = {
      start: performance.now(),
      from,
      mode: this.options.animations === 'full' ? 'move' : 'fade',
    };
  }

  private laneX(lane: number): number {
    return GRAPH_PADDING + this.laneWidth / 2 + lane * this.laneWidth;
  }

  /** The visible rows' SHAs and state flags, computed once per frame for rows and painter. */
  private frameFirst = 0;
  private readonly frameShas: string[] = [];
  private frameFlags = new Uint16Array(256);

  private prepareFrame(model: LogModel, first: number, last: number): void {
    const count = Math.max(0, last - first + 1);
    if (this.frameFlags.length < count) this.frameFlags = new Uint16Array(count * 2);
    this.frameFirst = first;
    this.frameShas.length = count;
    for (let i = 0; i < count; i++) {
      const sha = model.sha(first + i);
      this.frameShas[i] = sha;
      this.frameFlags[i] = this.computeFlags(model, first + i, sha);
    }
  }

  private frameSha(model: LogModel, row: number): string {
    const index = row - this.frameFirst;
    return index >= 0 && index < this.frameShas.length ? this.frameShas[index]! : model.sha(row);
  }

  private rowFlags(model: LogModel, row: number): number {
    const index = row - this.frameFirst;
    return index >= 0 && index < this.frameShas.length
      ? this.frameFlags[index]!
      : this.computeFlags(model, row, model.sha(row));
  }

  private computeFlags(model: LogModel, row: number, sha: string): number {
    let flags = 0;
    if (this.selected.has(sha)) flags |= RowFlag.Selected;
    if (row === this.hoverRow) flags |= RowFlag.Hovered;
    if (row === this.focusRow) flags |= RowFlag.Focused;
    if (model.isHeadSha(sha)) flags |= RowFlag.Head;
    const workingTree = row === 0 && model.hasWorkingTreeRow;
    if (workingTree) flags |= RowFlag.WorkingTree;
    if (row === this.dropRow) flags |= RowFlag.DropTarget;
    if (this.flashing?.has(sha)) flags |= RowFlag.Flash;
    // Selected rows stay legible even when they don't match.
    if (this.highlight && !workingTree && !(flags & RowFlag.Selected) && !this.highlight.shas.has(sha))
      flags |= RowFlag.Dimmed;
    return flags;
  }

  private ensureSlots(count: number): void {
    while (this.slots.length < count) {
      const row = el('div', styles.row!);
      row.setAttribute('role', 'row');
      const graph = el('div', styles.cell!);
      const message = el('div', `${styles.cell} ${styles.message}`);
      const refs = el('span', styles.refs!);
      const subject = el('span', styles.subject!);
      message.append(refs, subject);
      const author = el('div', `${styles.cell} ${styles.author}`);
      const avatar = el('span', styles.avatar!);
      const authorName = el('span', styles.authorName!);
      author.append(avatar, authorName);
      const date = el('div', `${styles.cell} ${styles.date}`);
      const sha = el('div', `${styles.cell} ${styles.sha}`);
      const cells = { message, author, date, sha };
      row.append(graph, ...this.options.columns.order.map((id) => cells[id]));
      for (const cell of [graph, message, author, date, sha]) cell.setAttribute('role', 'gridcell');
      this.rowsLayer.append(row);
      this.slots.push({
        el: row,
        graph,
        refs,
        subject,
        avatar,
        authorName,
        date,
        sha,
        cells,
        row: -1,
        shownSha: '',
        shownMeta: false,
        shownVersion: -1,
        stateKey: -1,
        y: NaN,
        opacity: '',
      });
    }
  }

  private renderRows(model: LogModel, first: number, last: number, t: number): void {
    const h = this.rowHeight;
    const count = last >= first ? last - first + 1 : 0;
    this.ensureSlots(count + 1);
    const transition = this.transition;

    // Reuse slots that already show a row in the window, so unchanged rows keep their DOM.
    const byRow = new Map<number, Slot>();
    const free: Slot[] = [];
    for (const slot of this.slots) {
      if (slot.row >= first && slot.row <= last && !byRow.has(slot.row)) byRow.set(slot.row, slot);
      else free.push(slot);
    }
    for (let row = first; row <= last; row++) {
      let slot = byRow.get(row);
      if (!slot) {
        slot = free.pop()!;
        slot.row = row;
        slot.shownSha = '';
        slot.el.id = `${this.idPrefix}-r${row}`;
      }
      if (slot.el.hidden) slot.el.hidden = false;
      let y = row * h - this.scrollTop;
      let opacity = '';
      if (transition && t < 1) {
        const from = transition.from.get(this.frameSha(model, row));
        if (from && transition.mode === 'move') y = from.y + (y - from.y) * t;
        else if (!from) opacity = String(t);
      }
      if (y !== slot.y) {
        slot.el.style.transform = `translateY(${y}px)`;
        slot.y = y;
      }
      if (opacity !== slot.opacity) {
        slot.el.style.opacity = opacity;
        slot.opacity = opacity;
      }
      this.fillSlot(model, slot, row);
    }
    for (const slot of free) {
      if (!slot.el.hidden) slot.el.hidden = true;
      slot.row = -1;
    }
    // Screen readers follow the focused row while keyboard focus stays on the grid.
    const focused =
      this.focusRow >= first && this.focusRow <= last ? `${this.idPrefix}-r${this.focusRow}` : '';
    if (focused !== this.activeDescendant) {
      this.activeDescendant = focused;
      if (focused) this.root.setAttribute('aria-activedescendant', focused);
      else this.root.removeAttribute('aria-activedescendant');
    }

    // Ghosts of rows that disappeared fade out; rows that still exist hand over to real rows.
    // Rewritten commits glide toward the commit they became while fading.
    if (transition && t < 1) {
      for (const ghost of this.ghostLayer.children as HTMLCollectionOf<HTMLElement>) {
        const sha = ghost.dataset.sha!;
        const stillThere = model.rowOf(sha) >= 0;
        const target = ghost.dataset.renamed ? model.rowOf(ghost.dataset.renamed) : -1;
        if (target >= 0 && !stillThere && transition.mode === 'move') {
          const fromY = Number(ghost.dataset.y);
          const toY = target * h - this.scrollTop;
          ghost.style.transform = `translateY(${fromY + (toY - fromY) * t}px)`;
          ghost.style.opacity = String((1 - t) * (1 - t));
        } else ghost.style.opacity = stillThere ? '0' : String(1 - t);
      }
    }
  }

  private fillSlot(model: LogModel, slot: Slot, row: number): void {
    const flags = this.rowFlags(model, row);
    const state =
      flags &
      (RowFlag.Selected |
        RowFlag.Hovered |
        RowFlag.Focused |
        RowFlag.Dimmed |
        RowFlag.DropTarget |
        RowFlag.Flash);
    if (state !== slot.stateKey) {
      slot.stateKey = state;
      slot.el.classList.toggle(styles.dropTarget!, (flags & RowFlag.DropTarget) !== 0);
      slot.el.classList.toggle(styles.flash!, (flags & RowFlag.Flash) !== 0);
      slot.el.classList.toggle(styles.selected!, (flags & RowFlag.Selected) !== 0);
      slot.el.classList.toggle(styles.hover!, (flags & RowFlag.Hovered) !== 0);
      slot.el.classList.toggle(styles.focused!, (flags & RowFlag.Focused) !== 0);
      slot.el.classList.toggle(styles.dim!, (flags & RowFlag.Dimmed) !== 0);
      slot.el.setAttribute('aria-selected', String((flags & RowFlag.Selected) !== 0));
    }

    const sha = this.frameSha(model, row);
    const meta = model.metaOf(sha);
    if (slot.shownSha === sha && slot.shownMeta === !!meta && slot.shownVersion === this.contentVersion)
      return;
    slot.shownSha = sha;
    slot.shownMeta = !!meta;
    slot.shownVersion = this.contentVersion;
    slot.el.dataset.row = String(row);
    slot.el.setAttribute('aria-rowindex', String(row + 2));
    const source = model.sourceAt(row);
    if (source || slot.marker) this.fillMarker(slot, source);

    if (flags & RowFlag.WorkingTree) {
      this.fillWorkingTree(model, slot);
      return;
    }
    slot.el.classList.toggle(styles.loading!, !meta);
    slot.el.classList.toggle(styles.match!, !!this.highlight?.shas.has(sha));
    this.fillRefs(model, slot, row);
    const mark = this.marks?.get(sha);
    if (mark) {
      const chip = el('span', `${styles.mark} ${styles[`mark-${mark.tone}`] ?? ''}`);
      chip.append(icon(mark.icon), mark.label);
      if (mark.title) chip.title = mark.title;
      slot.refs.prepend(chip);
    }
    slot.subject.className = styles.subject!;
    slot.subject.textContent = meta?.subject ?? '';
    slot.sha.textContent = shortSha(sha);
    if (meta) {
      slot.authorName.textContent = meta.author;
      slot.avatar.textContent = initials(meta.author);
      slot.avatar.style.background = avatarColor(
        stringHash(meta.authorEmail.toLowerCase()),
        this.options.palette.kind,
      );
      slot.date.textContent = relativeTime(meta.authorTime);
      // The full date is formatted on hover (Intl formatting is too slow for every scrolled row).
      slot.date.dataset.time = String(meta.authorTime);
      slot.date.removeAttribute('title');
      slot.el.title = '';
    } else {
      slot.authorName.textContent = '';
      slot.avatar.textContent = '';
      slot.date.textContent = '';
      delete slot.date.dataset.time;
      slot.el.title = '';
    }
  }

  /** Shows a row's repository: a stripe in its color, its name on hover and for screen readers. */
  private fillMarker(slot: Slot, source: RowSource | undefined): void {
    let marker = slot.marker;
    if (!marker) {
      marker = el('span', styles.repoMarker!);
      marker.setAttribute('aria-hidden', 'true');
      slot.graph.append(marker);
      slot.marker = marker;
    }
    marker.hidden = !source;
    if (!source) {
      slot.graph.removeAttribute('aria-label');
      return;
    }
    marker.style.setProperty('--lf-repo', repoColor(source.colorIndex, this.options.palette.kind));
    marker.title = source.name;
    slot.graph.setAttribute('aria-label', source.name);
  }

  private fillWorkingTree(model: LogModel, slot: Slot): void {
    slot.el.classList.remove(styles.loading!);
    slot.refs.replaceChildren();
    const tree = model.workingTree;
    const chips: [number, string, string][] = tree
      ? [
          [tree.conflicted, 'conflicted', styles.wipConflicted!],
          [tree.staged, 'staged', styles.wipStaged!],
          [tree.unstaged, 'modified', styles.wipModified!],
          [tree.untracked, 'untracked', styles.wipUntracked!],
        ]
      : [];
    for (const [count, label, cls] of chips) {
      if (count <= 0) continue;
      const chip = el('span', `${styles.wipChip} ${cls}`);
      chip.textContent = `${count} ${label}`;
      slot.refs.append(chip);
    }
    slot.subject.className = `${styles.subject} ${styles.wipSubject}`;
    slot.subject.textContent = 'Uncommitted changes';
    // Dragging them is not something a row says by itself.
    slot.el.title =
      'Select this row, then drag it onto a commit to amend that commit with the staged changes';
    slot.authorName.textContent = '';
    slot.avatar.textContent = '';
    slot.avatar.style.background = 'transparent';
    slot.date.textContent = 'now';
    slot.date.removeAttribute('title');
    delete slot.date.dataset.time;
    slot.sha.textContent = '';
  }

  private fillRefs(model: LogModel, slot: Slot, row: number): void {
    slot.refs.replaceChildren();
    const refs = model.refsAt(row) ?? [];
    const color = this.colors[model.layout.nodeColor[row] ?? 0] ?? this.colors[0]!;
    const rgb = this.rgb[model.layout.nodeColor[row] ?? 0];
    const onColor = rgb && luminance(rgb) > 0.45 ? '#1e1e1e' : '#ffffff';
    const remotesShown = new Set<string>();
    const pills: HTMLElement[] = [];
    const detachedHead = model.isDetachedHead(row);
    if (detachedHead) {
      const pill = this.pill('HEAD', 'git-commit', `${styles.pill} ${styles.pillHead}`, color, onColor);
      pill.title = 'HEAD (detached)';
      pills.push(pill);
    }
    for (const ref of refs) {
      if (ref.kind === 'branch') {
        const cls = `${styles.pill} ${ref.isHead ? styles.pillHead : ''}`;
        const pill = this.pill(ref.short, ref.isHead ? 'check' : 'git-branch', cls, color, onColor);
        // A local branch and its upstream on the same commit collapse into one pill.
        const upstream = ref.upstream
          ? refs.find((r) => r.kind === 'remote' && r.short === ref.upstream)
          : undefined;
        if (upstream) {
          remotesShown.add(upstream.short);
          pill.classList.add(styles.pillTracking!);
          const badge = el('span', styles.pillUpstream!);
          badge.append(icon('cloud'));
          pill.append(badge);
          pill.title = `${ref.short} (in sync with ${upstream.short})`;
        } else {
          const ahead = ref.ahead ?? 0;
          const behind = ref.behind ?? 0;
          pill.title = ref.upstream
            ? `${ref.short} → ${ref.upstream}${ahead || behind ? ` (↑${ahead} ↓${behind})` : ''}${ref.gone ? ' (upstream gone)' : ''}`
            : `${ref.short} (local only)`;
          if (ahead || behind) {
            const badge = el('span', styles.pillUpstream!);
            badge.textContent = `${ahead ? `↑${ahead}` : ''}${ahead && behind ? ' ' : ''}${behind ? `↓${behind}` : ''}`;
            pill.append(badge);
          }
        }
        this.wirePill(pill, ref);
        pills.push(pill);
      } else if (ref.kind === 'remote' && !remotesShown.has(ref.short)) {
        const pill = this.pill(ref.short, 'cloud', `${styles.pill} ${styles.pillRemote}`, color, onColor);
        pill.title = `${ref.short} (remote-tracking branch)`;
        this.wirePill(pill, ref);
        pills.push(pill);
      } else if (ref.kind === 'tag') {
        const pill = this.pill(ref.short, 'tag', `${styles.pill} ${styles.pillTag}`, color, onColor);
        pill.title = `${ref.annotated ? 'Annotated tag' : 'Tag'} ${ref.short}`;
        this.wirePill(pill, ref);
        pills.push(pill);
      }
    }
    // As many whole pills as fit (measured, not laid out), then "+N" for the rest.
    const budget = this.refsBudget();
    let shown = 0;
    let used = 0;
    for (const pill of pills) {
      const width = this.pillWidth(pill);
      const last = shown === pills.length - 1;
      // Keep room for the "+N" pill unless this is the last one.
      if (shown > 0 && (used + width + (last ? 0 : MORE_PILL_WIDTH) > budget || shown >= this.pillLimit))
        break;
      used += width;
      shown++;
    }
    if (shown < pills.length) {
      const more = el('span', `${styles.pill} ${styles.pillMore}`);
      more.textContent = `+${pills.length - shown}`;
      more.title = pills
        .slice(shown)
        .map((p) => p.title)
        .join('\n');
      slot.refs.append(...pills.slice(0, shown), more);
    } else slot.refs.append(...pills);
  }

  /** Pixels the ref pills of a row may take (the message column caps them at 62%). */
  private refsBudget(): number {
    let columns = this.graphWidth;
    for (const id of this.visible) if (id !== 'message') columns += COLUMN_WIDTHS[id];
    return Math.max(60, (this.viewportWidth - columns - 24) * 0.62);
  }

  private readonly pillWidths = new Map<string, number>();
  private measureContext: CanvasRenderingContext2D | null | undefined;

  /** A pill's width from its text (icon, padding, border and gap added), cached by text. */
  private pillWidth(pill: HTMLElement): number {
    const text = pill.textContent ?? '';
    let width = this.pillWidths.get(text);
    if (width === undefined) {
      this.measureContext ??= document.createElement('canvas').getContext('2d');
      if (this.measureContext) {
        this.measureContext.font = `600 11px ${getComputedStyle(this.root).fontFamily}`;
        width = this.measureContext.measureText(text).width;
      } else width = text.length * 6.5;
      width += 34;
      if (this.pillWidths.size > 4000) this.pillWidths.clear();
      this.pillWidths.set(text, width);
    }
    return Math.min(width, 220 + 4);
  }

  private pill(
    text: string,
    iconName: string,
    className: string,
    color: string,
    onColor: string,
  ): HTMLSpanElement {
    const pill = el('span', className);
    pill.style.setProperty('--c', color);
    pill.style.setProperty('--lf-pill-on', onColor);
    const label = el('span', styles.pillText!);
    label.textContent = text;
    pill.append(icon(iconName), label);
    return pill;
  }

  private paint(model: LogModel, first: number, last: number, t: number): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.ceil(this.graphWidth) + 4;
    const height = Math.ceil(this.viewportHeight);
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const transition = this.transition;
    const h = this.rowHeight;
    paintGraph({
      ctx: this.ctx,
      width,
      height,
      scrollTop: this.scrollTop,
      first,
      last,
      geometry: { rowHeight: h, laneWidth: this.laneWidth, originX: GRAPH_PADDING + this.laneWidth / 2 },
      layout: model.layout,
      topology: model.topology,
      colors: this.colors,
      curved: this.options.curved,
      background: this.background,
      accent: this.accent,
      rowFlags: (row) => this.rowFlags(model, row),
      nodePosition:
        transition && t < 1 && transition.mode === 'move'
          ? (row) => {
              const from = transition.from.get(this.frameSha(model, row));
              if (!from) return undefined;
              const x = this.laneX(model.layout.nodeLane[row] ?? 0);
              const y = row * h + h / 2 - this.scrollTop;
              return { x: from.x + (x - from.x) * t, y: from.y + h / 2 + (y - from.y - h / 2) * t };
            }
          : undefined,
    });
    if (transition && t < 1) this.canvas.style.opacity = String(0.35 + 0.65 * t);
    else this.canvas.style.opacity = '';
  }

  private renderScrollbar(model: LogModel): void {
    const rows = model.rowCount;
    const total = rows * this.rowHeight;
    const track = this.viewportHeight;
    // Markers stand for places along the scroll range: with nothing to scroll every row is in
    // view, and markers spread over the track would sit beside the wrong rows.
    const scrolls = total > track && track > 0;
    this.thumb.hidden = !scrolls;
    this.markers.hidden = !scrolls;
    if (!scrolls) return;
    const size = Math.max(24, (track / total) * track);
    const top = (this.scrollTop / (total - track)) * (track - size);
    this.thumb.style.height = `${size}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
    // Markers only change when rows, refs, selection or matches change — not on every frame.
    const key = `${rows}:${model.layout.rowsDone === rows}:${model.refsVersion}:${track}:${this.selectionVersion}:${this.highlightRows?.size ?? -1}`;
    if (key === this.markersKey) return;
    this.markersKey = key;
    const dpr = window.devicePixelRatio || 1;
    const width = 12;
    this.markers.width = width * dpr;
    this.markers.height = Math.max(1, track * dpr);
    this.markers.style.width = `${width}px`;
    this.markers.style.height = `${track}px`;
    const ctx = this.markers.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, track);
    if (rows === 0) return;
    const yOf = (row: number) => Math.min(track - 2, (row / rows) * track);
    const colorOf = (row: number) => this.colors[model.layout.nodeColor[row] ?? 0] ?? this.colors[0]!;
    // Branch tips in their lane color, matches and selection in theme colors, HEAD widest.
    for (const ref of model.refs.refs) {
      if (ref.kind !== 'branch') continue;
      const row = model.tipRows.get(ref.target);
      if (row === undefined || row >= rows) continue;
      ctx.fillStyle = colorOf(row);
      ctx.fillRect(width - 5, yOf(row), 4, 2);
    }
    if (this.highlightRows) {
      ctx.fillStyle = this.findMatch;
      for (const row of this.highlightRows.values()) if (row < rows) ctx.fillRect(1, yOf(row), 5, 2);
    }
    ctx.fillStyle = this.accent;
    for (const row of this.selected.values()) if (row < rows) ctx.fillRect(1, yOf(row), 10, 2);
    for (const sha of model.headShas()) {
      const head = model.tipRows.get(sha);
      if (head === undefined || head >= rows) continue;
      ctx.fillStyle = colorOf(head);
      ctx.fillRect(0, yOf(head) - 1, width, 3);
    }
  }

  private selectionVersion = 0;
  /** Rows of highlighted (matching) commits, resolved in one pass when the highlight is set. */
  private highlightRows: Map<string, number> | undefined;

  private renderStatus(model: LogModel): void {
    let text = '';
    if (model.phase === 'opening') text = 'Loading history…';
    else if (model.phase === 'streaming')
      text = `Loading history… ${model.topology.rowCount.toLocaleString()} commits`;
    else if (model.phase === 'error') text = `Could not load history: ${model.error ?? 'unknown error'}`;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.hidden = text === '';

    // Nothing to show: say why, in the middle of the graph.
    const empty = model.phase === 'ready' && model.rowCount === 0;
    let title = '';
    let detail = '';
    if (empty && this.emptyOverride) {
      title = this.emptyOverride.title;
      detail = this.emptyOverride.detail;
    } else if (empty && model.refs.head.unborn && model.refs.refs.length === 0) {
      title = 'No commits yet';
      detail = 'Add or change files: they show up here as uncommitted changes, ready for the first commit.';
    } else if (empty && model.refs.head.unborn) {
      title = 'No commits on this branch yet';
      detail = 'Its first commit will show up here. Other branches are in the “All” view.';
    } else if (empty) {
      title = 'No commits in this view';
      detail = 'Nothing this view shows has commits. Change what it shows from the toolbar.';
    }
    if (this.emptyTitle.textContent !== title) this.emptyTitle.textContent = title;
    if (this.emptyText.textContent !== detail) this.emptyText.textContent = detail;
    this.emptyActions.hidden = !(empty && this.emptyOverride?.actions?.length);
    this.emptyNote.hidden = !empty;
  }

  // ---- interaction --------------------------------------------------------------------------

  private attachEvents(): void {
    this.body.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey) return; // pinch zoom
        event.preventDefault();
        this.setHover(-1);
        const unit = event.deltaMode === 1 ? this.rowHeight : event.deltaMode === 2 ? this.viewportHeight : 1;
        const delta = event.deltaY * unit;
        // Mouse wheels (big discrete steps) glide; trackpads (small deltas) track 1:1.
        const smooth = Math.abs(delta) >= 50 && this.options.animations !== 'off';
        this.scrollTo(this.scrollTarget + delta, smooth);
      },
      { passive: false },
    );

    this.rowsLayer.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.rowsLayer.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.rowsLayer.addEventListener('pointerup', (event) => this.endDrag(event));
    this.rowsLayer.addEventListener('pointercancel', (event) => this.endDrag(event));
    this.rowsLayer.addEventListener('pointerleave', () => this.setHover(-1));
    this.rowsLayer.addEventListener('pointerover', (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>(`.${styles.date}`);
      if (cell?.dataset.time && !cell.title) cell.title = absoluteTime(Number(cell.dataset.time));
    });
    this.rowsLayer.addEventListener('dblclick', (event) => {
      const row = this.rowFromEvent(event);
      if (row >= 0) this.callbacks.onOpen(row);
    });
    this.rowsLayer.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const row = this.rowFromEvent(event);
      if (row < 0 || !this.model) return;
      if (!this.selected.has(this.model.sha(row))) this.selectSingle(row);
      this.callbacks.onContextMenu(row, event.clientX, event.clientY);
    });

    this.root.addEventListener('keydown', (event) => this.onKeyDown(event));

    // Column headings: a menu of the columns, dragged sideways to move, and keys of their own.
    this.header.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const column = (event.target as HTMLElement).closest<HTMLElement>('[data-column]')?.dataset.column;
      this.openColumnsMenu(isColumnId(column) ? column : undefined, { x: event.clientX, y: event.clientY });
    });
    // A click leaves focus where it was (the rows): Tab reaches the headings.
    this.header.addEventListener('mousedown', (event) => event.preventDefault());
    this.header.addEventListener('pointerdown', (event) => this.onHeaderPointerDown(event));
    this.header.addEventListener('keydown', (event) => this.onHeaderKeyDown(event));

    this.thumb.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.thumb.setPointerCapture(event.pointerId);
      this.thumb.classList.add(styles.dragging!);
      const startY = event.clientY;
      const startScroll = this.scrollTop;
      const move = (e: PointerEvent) => {
        const total = (this.model?.rowCount ?? 0) * this.rowHeight;
        const track = this.viewportHeight;
        const size = Math.max(24, (track / Math.max(total, 1)) * track);
        const ratio = (total - track) / Math.max(1, track - size);
        this.scrollTo(startScroll + (e.clientY - startY) * ratio, false);
      };
      const up = () => {
        this.thumb.classList.remove(styles.dragging!);
        this.thumb.removeEventListener('pointermove', move);
        this.thumb.removeEventListener('pointerup', up);
        this.thumb.removeEventListener('pointercancel', up);
        this.thumb.removeEventListener('lostpointercapture', up);
      };
      this.thumb.addEventListener('pointermove', move);
      this.thumb.addEventListener('pointerup', up);
      // A pointer taken away (touch turned into a gesture, capture lost) ends the drag as well.
      this.thumb.addEventListener('pointercancel', up);
      this.thumb.addEventListener('lostpointercapture', up);
    });
    this.scrollbar.addEventListener('pointerdown', (event) => {
      if (event.target === this.thumb || !this.model) return;
      // Click on the track: jump to that point of history.
      const rect = this.scrollbar.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / rect.height;
      this.scrollTo(ratio * this.model.rowCount * this.rowHeight - this.viewportHeight / 2, true);
    });
  }

  private openColumnsMenu(column: ColumnId | undefined, anchor: Element | { x: number; y: number }): void {
    this.setHover(-1);
    this.callbacks.onColumnsMenu?.(column, anchor, { visible: this.visible, dropped: this.dropped });
  }

  /** Keys on a focused heading: arrows move between headings, Alt+arrows move the column. */
  private onHeaderKeyDown(event: KeyboardEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-column]');
    const column = cell?.dataset.column;
    if (!cell || !isColumnId(column)) return;
    const visible = this.visible;
    const index = visible.indexOf(column);
    const focusAt = (at: number) => {
      const next = visible[Math.max(0, Math.min(visible.length - 1, at))];
      if (!next) return;
      this.setHeaderFocus(next);
      this.headerCells[next].focus();
    };
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (horizontal && event.altKey) {
      const next = shiftColumn(this.options.columns, column, event.key === 'ArrowLeft' ? -1 : 1, visible);
      if (next) this.callbacks.onColumnsChange?.(next);
    } else if (horizontal) focusAt(index + (event.key === 'ArrowLeft' ? -1 : 1));
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(visible.length - 1);
    // Down to the rows again.
    else if (event.key === 'ArrowDown' || event.key === 'Escape') this.focus();
    else if (
      event.key === 'Enter' ||
      event.key === ' ' ||
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey)
    )
      this.openColumnsMenu(column, cell);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** A press on a heading: dragged sideways, it moves its column where it is dropped. */
  private onHeaderPointerDown(event: PointerEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-column]');
    const column = cell?.dataset.column;
    if (event.button !== 0 || !cell || !isColumnId(column) || !this.callbacks.onColumnsChange) return;
    this.columnDrag?.stop();
    const startX = event.clientX;
    const pointerId = event.pointerId;
    let active = false;
    let bounds = { min: 0, max: 0 };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
        active = true;
        // The heading follows the pointer between the lanes' heading and the header's end.
        const header = this.header.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        bounds = {
          min: header.left + this.graphWidth - rect.left,
          max: header.right - rect.right,
        };
        cell.classList.add(styles.headerDragged!);
        this.root.classList.add(styles.columnsDragging!);
        this.setHover(-1);
      }
      const dx = Math.max(bounds.min, Math.min(bounds.max, e.clientX - startX));
      cell.style.transform = `translateX(${dx}px)`;
      this.showColumnDrop(this.columnDropAt(column, e.clientX));
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const target = active ? this.columnDropAt(column, e.clientX) : undefined;
      stop();
      if (target) this.callbacks.onColumnsChange?.(moveColumn(this.options.columns, column, target.before));
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) stop();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active) return;
      e.preventDefault();
      e.stopPropagation();
      stop();
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cell.classList.remove(styles.headerDragged!);
      cell.style.transform = '';
      this.root.classList.remove(styles.columnsDragging!);
      this.showColumnDrop(undefined);
      if (this.columnDrag === drag) this.columnDrag = undefined;
    };
    const drag = { stop };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    this.columnDrag = drag;
  }

  /**
   * Where a heading dropped at `clientX` takes its column: before the column on screen whose
   * middle is past that point (`before` undefined: to the end), and the line between the two
   * (`x`, from the graph's left). Undefined when the column would stay where it is.
   */
  private columnDropAt(column: ColumnId, clientX: number): { before?: ColumnId; x: number } | undefined {
    const others = this.visible.filter((other) => other !== column);
    const last = others[others.length - 1];
    if (!last) return undefined;
    const before = others.find((other) => {
      const rect = this.headerCells[other].getBoundingClientRect();
      return clientX < rect.left + rect.width / 2;
    });
    const next = moveColumn(this.options.columns, column, before);
    if (visibleColumns(next, this.dropped).join() === this.visible.join()) return undefined;
    const edge = before
      ? this.headerCells[before].getBoundingClientRect().left
      : this.headerCells[last].getBoundingClientRect().right;
    return { before, x: edge - this.root.getBoundingClientRect().left };
  }

  private showColumnDrop(target: { x: number } | undefined): void {
    this.columnDrop.hidden = !target;
    if (target) this.columnDrop.style.transform = `translateX(${Math.round(target.x)}px)`;
  }

  private rowFromEvent(event: Event): number {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(`.${styles.row}`);
    const row = target?.dataset.row;
    return row === undefined ? -1 : Number(row);
  }

  private rowAtClientY(clientY: number): number {
    const rect = this.body.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top + this.scrollTop) / this.rowHeight);
    return Math.max(0, Math.min((this.model?.rowCount ?? 1) - 1, row));
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.model) return;
    if ((event.target as HTMLElement).closest(`.${styles.pill}`)) return;
    const row = this.rowFromEvent(event);
    if (row < 0) return;
    this.focus();
    const sha = this.model.sha(row);
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey;
    // The uncommitted changes, selected, can be dragged onto a commit to amend it.
    if (
      plain &&
      row === 0 &&
      this.model.hasWorkingTreeRow &&
      this.selected.has(sha) &&
      this.callbacks.onDrop
    ) {
      this.startPress({ kind: 'changes' }, event, row);
      return;
    }
    if (
      plain &&
      this.selected.has(sha) &&
      !(row === 0 && this.model.hasWorkingTreeRow) &&
      this.callbacks.onDrop
    ) {
      // Pressing a selected commit may start dragging the selection (a click selects just it).
      const model = this.model;
      const shas = [...this.selected.entries()]
        .filter(([, selectedRow]) => !(selectedRow === 0 && model.hasWorkingTreeRow))
        .sort((a, b) => a[1] - b[1])
        .map(([selectedSha]) => selectedSha);
      this.startPress({ kind: 'commits', shas }, event, row);
      return;
    }
    if (event.shiftKey && this.anchorRow >= 0) {
      this.selectRange(this.anchorRow, row, event.ctrlKey || event.metaKey);
    } else if (event.ctrlKey || event.metaKey) {
      this.toggle(row);
    } else {
      this.selectSingle(row);
      this.dragSelect = { pointerId: event.pointerId, startRow: row };
      this.rowsLayer.setPointerCapture(event.pointerId);
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragSelect && event.pointerId === this.dragSelect.pointerId) {
      const row = this.rowAtClientY(event.clientY);
      if (row !== this.focusRow) this.selectRange(this.dragSelect.startRow, row, false, false);
      // Auto-scroll when dragging past the edges.
      const rect = this.body.getBoundingClientRect();
      const edge = 28;
      this.autoScroll =
        event.clientY < rect.top + edge
          ? -Math.min(24, rect.top + edge - event.clientY)
          : event.clientY > rect.bottom - edge
            ? Math.min(24, event.clientY - (rect.bottom - edge))
            : 0;
      if (this.autoScroll) this.invalidate();
      return;
    }
    const row = this.rowFromEvent(event);
    this.setHover(row);
  }

  private applyAutoScroll(): void {
    if (!this.dragSelect && !this.drag?.active) {
      this.autoScroll = 0;
      return;
    }
    this.scrollTo(this.scrollTarget + this.autoScroll, false);
  }

  private endDrag(event: PointerEvent): void {
    if (this.dragSelect?.pointerId === event.pointerId) {
      this.dragSelect = undefined;
      this.autoScroll = 0;
      if (this.rowsLayer.hasPointerCapture(event.pointerId))
        this.rowsLayer.releasePointerCapture(event.pointerId);
    }
  }

  private wirePill(pill: HTMLElement, ref: RefInfo): void {
    pill.addEventListener('click', (event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.callbacks.onRefClick?.(ref, event);
    });
    pill.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.callbacks.onDrop) return;
      this.startPress({ kind: 'ref', ref }, event, -1);
    });
    // A right click on a pill opens the branch's (or tag's) menu, not its commit's.
    pill.addEventListener('contextmenu', (event) => {
      if (!this.callbacks.onRefClick) return;
      event.preventDefault();
      event.stopPropagation();
      this.setHover(-1);
      this.callbacks.onRefClick(ref, event);
    });
  }

  /** A press that becomes a drag once the pointer travels a few pixels. */
  private startPress(item: DragItem, event: PointerEvent, pressRow: number): void {
    this.drag?.stop();
    const move = (e: PointerEvent) => this.onDragMove(e);
    const up = (e: PointerEvent) => this.onDragEnd(e, false);
    const cancel = (e: PointerEvent) => this.onDragEnd(e, true);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.drag) {
        e.preventDefault();
        this.finishDrag(true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    this.drag = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pressRow,
      active: false,
      stop: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', key, true);
      },
    };
  }

  private onDragMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.ghost = this.createGhost(drag.item);
      this.root.classList.add(styles.dragging!);
      this.setHover(-1);
    }
    const rootRect = this.root.getBoundingClientRect();
    drag.ghost!.style.transform = `translate(${event.clientX - rootRect.left + 14}px, ${event.clientY - rootRect.top + 10}px)`;
    const body = this.body.getBoundingClientRect();
    const inside =
      event.clientX >= body.left &&
      event.clientX <= body.right &&
      event.clientY >= body.top &&
      event.clientY <= body.bottom;
    const row = inside ? this.rowAtClientY(event.clientY) : -1;
    if (row !== this.dropRow) {
      this.dropRow = row;
      this.invalidate();
    }
    const edge = 28;
    this.autoScroll =
      event.clientY < body.top + edge
        ? -Math.min(24, body.top + edge - event.clientY)
        : event.clientY > body.bottom - edge
          ? Math.min(24, event.clientY - (body.bottom - edge))
          : 0;
    if (this.autoScroll) this.invalidate();
  }

  private onDragEnd(event: PointerEvent, cancelled: boolean): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      // A press without movement: a click on a selected commit selects just that commit.
      this.finishDrag(true);
      if (drag.item.kind !== 'ref' && drag.pressRow >= 0 && !cancelled) this.selectSingle(drag.pressRow);
      return;
    }
    const target = this.dropRow;
    this.finishDrag(cancelled);
    if (drag.item.kind === 'ref') {
      // The pill receives a click right after this pointerup: it must not open the menu.
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    }
    if (!cancelled && target >= 0) this.callbacks.onDrop?.(drag.item, target, event.clientX, event.clientY);
  }

  private finishDrag(_cancelled: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    drag.stop();
    drag.ghost?.remove();
    this.drag = undefined;
    this.autoScroll = 0;
    this.root.classList.remove(styles.dragging!);
    if (this.dropRow !== -1) {
      this.dropRow = -1;
      this.invalidate();
    }
  }

  private createGhost(item: DragItem): HTMLElement {
    const ghost = el('div', styles.dragGhost!);
    if (item.kind === 'ref') {
      ghost.append(
        icon(item.ref.kind === 'tag' ? 'tag' : item.ref.kind === 'remote' ? 'cloud' : 'git-branch'),
      );
      const label = el('span', '');
      label.textContent = item.ref.short;
      ghost.append(label);
    } else if (item.kind === 'changes') {
      ghost.append(icon('diff-multiple'));
      const label = el('span', '');
      label.textContent = 'Uncommitted changes';
      ghost.append(label);
    } else {
      ghost.append(icon('git-commit'));
      const label = el('span', '');
      const first = this.model?.metaOf(item.shas[0] ?? '')?.subject;
      label.textContent =
        item.shas.length === 1 ? (first ?? shortSha(item.shas[0] ?? '')) : `${item.shas.length} commits`;
      ghost.append(label);
    }
    this.root.append(ghost);
    return ghost;
  }

  private setHover(row: number): void {
    if (row === this.hoverRow) return;
    this.hoverRow = row;
    this.invalidate();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (row < 0) {
      this.callbacks.onHover(undefined, undefined);
      return;
    }
    this.hoverTimer = setTimeout(() => {
      // Selected rows already show their details in the side pane: no hover card for them.
      const selected = this.model ? this.selected.has(this.model.sha(row)) : false;
      if (this.hoverRow === row && !this.dragSelect && !selected)
        this.callbacks.onHover(row, this.rowRect(row));
    }, 650);
  }

  private emitSelection(): void {
    const model = this.model;
    if (!model) return;
    const ordered = [...this.selected.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => sha);
    this.callbacks.onSelectionChange(
      ordered,
      this.focusRow < model.rowCount ? model.sha(this.focusRow) : undefined,
    );
    this.selectionVersion++;
    this.invalidate();
  }

  private selectSingle(row: number): void {
    if (!this.model) return;
    this.selected = new Map([[this.model.sha(row), row]]);
    this.anchorRow = this.focusRow = row;
    this.emitSelection();
  }

  private toggle(row: number): void {
    if (!this.model) return;
    const sha = this.model.sha(row);
    if (this.selected.has(sha)) this.selected.delete(sha);
    else this.selected.set(sha, row);
    this.anchorRow = this.focusRow = row;
    this.emitSelection();
  }

  private selectRange(from: number, to: number, additive: boolean, moveAnchor = false): void {
    if (!this.model) return;
    const next = additive ? new Map(this.selected) : new Map<string, number>();
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let row = a; row <= b; row++) next.set(this.model.sha(row), row);
    this.selected = next;
    this.focusRow = to;
    if (moveAnchor) this.anchorRow = to;
    this.emitSelection();
    this.revealRow(to);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const model = this.model;
    // The headings have keys of their own (see onHeaderKeyDown).
    if (!model || model.rowCount === 0 || this.header.contains(event.target as Node)) return;
    const pageRows = Math.max(1, Math.floor(this.viewportHeight / this.rowHeight) - 1);
    const move = (row: number) => {
      const target = Math.max(0, Math.min(model.rowCount - 1, row));
      if (event.shiftKey)
        this.selectRange(this.anchorRow >= 0 ? this.anchorRow : this.focusRow, target, false);
      else if (event.ctrlKey || event.metaKey) {
        this.focusRow = target;
        this.revealRow(target);
        this.invalidate();
      } else {
        this.selectSingle(target);
        this.revealRow(target);
      }
    };
    switch (event.key) {
      case 'ArrowDown':
        move(this.focusRow + 1);
        break;
      case 'ArrowUp':
        move(this.focusRow - 1);
        break;
      case 'PageDown':
        move(this.focusRow + pageRows);
        break;
      case 'PageUp':
        move(this.focusRow - pageRows);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(model.rowCount - 1);
        break;
      case 'ArrowRight': {
        // To the first parent (older), as in the graph's downward flow.
        const parent =
          model.topology.parentCount(this.focusRow) > 0 ? model.topology.parentRow(this.focusRow, 0) : -1;
        if (parent >= 0) move(parent);
        break;
      }
      case 'ArrowLeft': {
        const children = model.childrenOf(this.focusRow);
        if (children.length > 0) move(children[children.length - 1]!);
        break;
      }
      case ' ':
        if (event.ctrlKey || event.metaKey) this.toggle(this.focusRow);
        else return;
        break;
      case 'Enter':
        this.callbacks.onOpen(this.focusRow);
        break;
      case 'Escape':
        if (this.selected.size === 0) return;
        this.selected.clear();
        this.emitSelection();
        break;
      case 'a':
        if (!(event.ctrlKey || event.metaKey)) return;
        return; // Select-all over a whole history is rarely useful; leave the default (no-op).
      case 'F10':
      case 'ContextMenu': {
        if (event.key === 'F10' && !event.shiftKey) return;
        const rect = this.rowRect(this.focusRow);
        if (rect) this.callbacks.onContextMenu(this.focusRow, rect.left + 48, rect.bottom);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

/** Room kept for the "+N" pill. */
const MORE_PILL_WIDTH = 34;

function icon(name: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}
