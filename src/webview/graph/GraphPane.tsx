import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefInfo } from '../../shared/models';
import { useApp } from '../state/store';
import { useAnimationLevel, usePalette } from '../state/theme';
import { GraphView, type DragItem, type EmptyNote, type Highlight, type RowMark } from './GraphView';
import type { LogModel } from './logModel';

export interface GraphPaneCallbacks {
  onSelectionChange?(shas: readonly string[], focused: string | undefined): void;
  onContextMenu?(row: number, clientX: number, clientY: number): void;
  onOpen?(row: number): void;
  onHover?(row: number | undefined, rect: DOMRect | undefined): void;
  onRefClick?(ref: RefInfo, event: MouseEvent): void;
  onDrop?(item: DragItem, targetRow: number, clientX: number, clientY: number): void;
}

export interface GraphPaneProps extends GraphPaneCallbacks {
  readonly model: LogModel | undefined;
  /** Animate the switch to a new model (refresh, view change, filter). */
  readonly animate?: boolean;
  readonly highlight?: Highlight;
  /** Status chips on commits (an operation's progress). */
  readonly marks?: ReadonlyMap<string, RowMark>;
  /** What to say when there are no rows, in place of the graph's own words. */
  readonly emptyNote?: EmptyNote;
  readonly className?: string;
  /** Receives the imperative graph (for keyboard shortcuts, reveal, selection). */
  readonly graphRef?: { current: GraphView | undefined };
  readonly label?: string;
}

/** Mounts the imperative {@link GraphView} and keeps it in sync with React state. */
export function GraphPane({
  model,
  animate,
  highlight,
  marks,
  emptyNote,
  className,
  graphRef,
  label,
  ...callbacks
}: GraphPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GraphView | undefined>(undefined);
  const callbacksRef = useRef(callbacks);
  useLayoutEffect(() => {
    callbacksRef.current = callbacks;
  });

  const settings = useApp((state) => state.settings);
  const palette = usePalette();
  const animations = useAnimationLevel();
  const options = useMemo(
    () => ({
      density: settings.density,
      curved: settings.graphStyle === 'curved',
      palette,
      animations,
    }),
    [settings.density, settings.graphStyle, palette, animations],
  );

  useLayoutEffect(() => {
    const view = new GraphView(
      containerRef.current!,
      {
        onSelectionChange: (shas, focused) => callbacksRef.current.onSelectionChange?.(shas, focused),
        onContextMenu: (row, x, y) => callbacksRef.current.onContextMenu?.(row, x, y),
        onOpen: (row) => callbacksRef.current.onOpen?.(row),
        onHover: (row, rect) => callbacksRef.current.onHover?.(row, rect),
        onRefClick: (ref, event) => callbacksRef.current.onRefClick?.(ref, event),
        // Only views where a drop does something let pills and commits be dragged.
        onDrop: callbacksRef.current.onDrop
          ? (item, row, x, y) => callbacksRef.current.onDrop?.(item, row, x, y)
          : undefined,
      },
      options,
    );
    if (label) view.root.setAttribute('aria-label', label);
    viewRef.current = view;
    if (graphRef) graphRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = undefined;
      if (graphRef) graphRef.current = undefined;
    };
    // The graph lives as long as the pane; everything else is pushed through effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => viewRef.current?.setOptions(options), [options]);

  useLayoutEffect(() => {
    viewRef.current?.setModel(model, { animate });
    // `animate` describes this particular model switch only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => viewRef.current?.setHighlight(highlight), [highlight, model]);
  useEffect(() => viewRef.current?.setMarks(marks), [marks, model]);
  useEffect(() => viewRef.current?.setEmptyNote(emptyNote), [emptyNote]);

  return <div ref={containerRef} className={className} />;
}
