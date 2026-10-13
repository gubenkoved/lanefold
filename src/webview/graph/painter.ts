import { EDGE_ELIDED, EDGE_MISSING, EDGE_OPEN, type GraphLayout } from '../../shared/graph/layout';
import type { GraphTopology } from '../../shared/graph/topology';

export interface GraphGeometry {
  readonly rowHeight: number;
  readonly laneWidth: number;
  /** X of lane 0's center. */
  readonly originX: number;
}

export const enum RowFlag {
  None = 0,
  Selected = 1,
  Hovered = 2,
  Dimmed = 4,
  Head = 8,
  WorkingTree = 16,
  Focused = 32,
  /** The row under a dragged branch or commits. */
  DropTarget = 64,
  /** Briefly glowing (just rewritten). */
  Flash = 128,
}

export interface PaintRequest {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** Scroll position in pixels (top of row 0 is at y = -scrollTop). */
  readonly scrollTop: number;
  readonly first: number;
  readonly last: number;
  readonly geometry: GraphGeometry;
  readonly layout: GraphLayout;
  readonly topology: GraphTopology;
  readonly colors: readonly string[];
  readonly curved: boolean;
  readonly background: string;
  readonly accent: string;
  readonly rowFlags: (row: number) => number;
  /** Lane/row positions that override the layout during transitions (row → {x, y}). */
  readonly nodePosition?: (row: number) => { x: number; y: number } | undefined;
}

const LINE_WIDTH = 2;
const NODE_RADIUS = 4;
/** Fraction of a row the long-edge stubs extend. */
const STUB = 0.62;
/** Length (in rows) of the dashed stub for a parent outside the view. */
const MISSING_STUB = 1.1;

/** Draws lanes and nodes for the visible rows. */
export function paintGraph(req: PaintRequest): void {
  const { ctx, geometry: g, layout, topology, colors, scrollTop } = req;
  ctx.clearRect(0, 0, req.width, req.height);
  const h = g.rowHeight;
  const laneX = (lane: number) => g.originX + lane * g.laneWidth;
  const rowY = (row: number) => row * h + h / 2 - scrollTop;
  const pos = (row: number, lane: number): [number, number] => {
    const override = req.nodePosition?.(row);
    if (override && lane === layout.nodeLane[row]) return [override.x, override.y];
    return [laneX(lane), rowY(row)];
  };

  // One path per color: thousands of segments become a handful of stroke() calls.
  const paths = new Map<number, Path2D>();
  const dashed = new Map<number, Path2D>();
  const pathFor = (color: number, map = paths) => {
    let path = map.get(color);
    if (!path) map.set(color, (path = new Path2D()));
    return path;
  };

  const e = layout.edges;
  const edgeIds = layout.edgesInWindow(Math.max(0, req.first - 1), req.last + 1, []);
  const bottom = req.height + h;

  for (const id of edgeIds) {
    const flags = e.flags[id]!;
    const color = e.color[id]!;
    const fromRow = e.fromRow[id]!;
    const toRow = e.toRow[id]!;
    const fromLane = e.fromLane[id]!;
    const travel = e.travel[id]!;
    const toLane = e.toLane[id]!;

    if (flags & EDGE_ELIDED) {
      // Departure stub below the child, arrival stub above the parent; each ends in an arrowhead.
      const path = pathFor(color, flags & EDGE_MISSING ? dashed : paths);
      if (fromRow >= req.first - 1 && fromRow <= req.last + 1) {
        const [x, y] = pos(fromRow, fromLane);
        const end = y + h * STUB;
        path.moveTo(x, y);
        path.lineTo(x, end);
        path.moveTo(x - 3, end - 3.5);
        path.lineTo(x, end);
        path.lineTo(x + 3, end - 3.5);
      }
      if (!(flags & (EDGE_MISSING | EDGE_OPEN)) && toRow >= req.first - 1 && toRow <= req.last + 1) {
        const [x, y] = pos(toRow, toLane);
        const start = y - h * STUB;
        path.moveTo(x, start);
        path.lineTo(x, y);
        path.moveTo(x - 3, start + 3.5);
        path.lineTo(x, start);
        path.lineTo(x + 3, start + 3.5);
      }
      continue;
    }

    const path = pathFor(color, flags & EDGE_MISSING ? dashed : paths);
    const open = (flags & (EDGE_OPEN | EDGE_MISSING)) !== 0 || toRow < 0;
    // Vertices of the edge polyline: (row, lane) pairs; lane changes take exactly one row.
    const [x0, y0] = pos(fromRow, fromLane);
    path.moveTo(x0, y0);
    let cx = x0;
    let cy = y0;
    const segment = (x: number, y: number) => {
      if (x === cx) path.lineTo(x, y);
      else if (req.curved) {
        const mid = (cy + y) / 2;
        path.bezierCurveTo(cx, mid, x, mid, x, y);
      } else path.lineTo(x, y);
      cx = x;
      cy = y;
    };
    if (!open && toRow === fromRow + 1) {
      const [x, y] = pos(toRow, toLane);
      segment(x, y);
      continue;
    }
    if (travel !== fromLane) segment(laneX(travel), rowY(fromRow + 1));
    if (open) {
      // Still streaming: the parent may arrive below, so the line runs on. Never coming (outside
      // the view, shallow boundary): a short dashed stub says "continues elsewhere".
      segment(laneX(travel), flags & EDGE_MISSING ? cy + h * MISSING_STUB : Math.max(cy, bottom));
      continue;
    }
    if (toLane !== travel) {
      segment(laneX(travel), rowY(toRow - 1));
      const [x, y] = pos(toRow, toLane);
      segment(x, y);
    } else {
      const [x, y] = pos(toRow, toLane);
      segment(x, y);
    }
  }

  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [color, path] of paths) {
    ctx.strokeStyle = colors[color] ?? colors[0]!;
    ctx.stroke(path);
  }
  if (dashed.size > 0) {
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.6;
    for (const [color, path] of dashed) {
      ctx.strokeStyle = colors[color] ?? colors[0]!;
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Nodes on top of the lines.
  const last = Math.min(req.last, layout.rowsDone - 1);
  for (let row = Math.max(0, req.first); row <= last; row++) {
    const flags = req.rowFlags(row);
    const [x, y] = pos(row, layout.nodeLane[row]!);
    const color = colors[layout.nodeColor[row]!] ?? colors[0]!;
    ctx.globalAlpha = flags & RowFlag.Dimmed ? 0.35 : 1;

    if (flags & RowFlag.WorkingTree) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = req.background;
      ctx.fill();
      ctx.setLineDash([2.5, 2.5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }

    if (flags & RowFlag.Head) {
      // Soft halo marks where you are.
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha *= 0.22;
      ctx.fill();
      ctx.globalAlpha = flags & RowFlag.Dimmed ? 0.35 : 1;
    }

    const merge = topology.parentCount(row) > 1;
    // A background-colored ring separates the node from lines passing behind it.
    ctx.beginPath();
    ctx.arc(x, y, NODE_RADIUS + 2, 0, Math.PI * 2);
    ctx.fillStyle = req.background;
    ctx.fill();
    ctx.beginPath();
    if (merge) {
      ctx.arc(x, y, NODE_RADIUS - 0.5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.arc(x, y, flags & RowFlag.Head ? NODE_RADIUS + 1 : NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (flags & RowFlag.Selected) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = req.accent;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}
