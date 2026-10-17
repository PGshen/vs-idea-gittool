import { GraphEdge, GraphRow } from '../shared/types';

/** One edge of the commit graph: child commit -> parent commit, with its row span. */
export interface Segment {
  /** Row index of the child commit (edge start). */
  start: number;
  /** Row index of the parent commit, once it is loaded. */
  end?: number;
  from: string;
  to: string;
  /** Hidden commits of a collapsed linear branch lie on this edge; it is drawn dotted. */
  collapsed?: number;
}

/**
 * Incremental lane layout for the commit graph. Feed commits in topological (or date) order with
 * `add()`; each call returns the row to draw. The state survives between calls, so more commits
 * can be appended when the log loads the next page.
 *
 * Coordinates: lanes are columns; y=0 is the row top, y=1 the commit circle, y=2 the row bottom.
 */
export class GraphLayout {
  /** Hash expected next in each lane, or null for a free lane. */
  private lanes: (string | null)[] = [];
  private laneColors: number[] = [];
  /** Edge segment carried by each lane. */
  private laneSegs: number[] = [];
  private nextColor = 0;
  private row = 0;
  /** Edge segments (one per child -> parent edge) with their row span. */
  readonly segments: Segment[] = [];
  /** Hashes present in the loaded log, used to draw edges to filtered out parents as dashed. */
  private readonly known: Set<string> | undefined;

  constructor(known?: Set<string>) {
    this.known = known;
  }

  private newColor(): number {
    return this.nextColor++;
  }

  private newSeg(from: string, to: string): number {
    this.segments.push({ start: this.row, from, to });
    return this.segments.length - 1;
  }

  /**
   * Leaves a commit out of the graph (Collapse Linear Branches): edges that wait for it now wait for its parent.
   */
  collapse(hash: string, parent: string) {
    for (let j = 0; j < this.lanes.length; j++) {
      if (this.lanes[j] !== hash) continue;
      this.lanes[j] = parent;
      const seg = this.segments[this.laneSegs[j]];
      if (seg) {
        seg.to = parent;
        seg.collapsed = (seg.collapsed ?? 0) + 1;
      }
    }
  }

  add(hash: string, parents: string[]): GraphRow {
    const lanes = this.lanes;
    const colors = this.laneColors;
    const segs = this.laneSegs;
    const row = this.row;
    const before = lanes.length;

    let nodeLane = lanes.indexOf(hash);
    const isNewLane = nodeLane < 0;
    if (isNewLane) {
      nodeLane = lanes.indexOf(null);
      if (nodeLane < 0) nodeLane = lanes.length;
      lanes[nodeLane] = hash;
      colors[nodeLane] = this.newColor();
      segs[nodeLane] = -1;
    }
    const nodeColor = colors[nodeLane];
    const top = lanes.map((h, j) => (h === null ? -1 : segs[j]));

    // Segments that end at this commit.
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === hash && segs[j] >= 0) this.segments[segs[j]].end = row;

    // Next state: copy, then clear every lane that waited for this commit.
    const next = lanes.slice();
    const nextColors = colors.slice();
    const nextSegs = segs.slice();
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === hash) next[j] = null;

    // Parents: the first one continues the node lane, others reuse an existing lane or get a new one.
    const parentTargets: { lane: number; color: number; dashed: boolean; seg: number }[] = [];
    parents.forEach((p, i) => {
      const dashed = this.known !== undefined && !this.known.has(p);
      if (i === 0) {
        const existing = next.indexOf(p);
        if (existing >= 0 && existing < nodeLane) {
          // Converge into a lane on the left that already waits for the parent.
          parentTargets.push({ lane: existing, color: nextColors[existing], dashed, seg: nextSegs[existing] });
        } else {
          next[nodeLane] = p;
          nextColors[nodeLane] = nodeColor;
          nextSegs[nodeLane] = this.newSeg(hash, p);
          parentTargets.push({ lane: nodeLane, color: nodeColor, dashed, seg: nextSegs[nodeLane] });
        }
        return;
      }
      const existing = next.indexOf(p);
      if (existing >= 0) {
        parentTargets.push({ lane: existing, color: nextColors[existing], dashed, seg: nextSegs[existing] });
        return;
      }
      let free = next.indexOf(null, nodeLane + 1);
      if (free < 0) free = next.length;
      next[free] = p;
      nextColors[free] = this.newColor();
      nextSegs[free] = this.newSeg(hash, p);
      parentTargets.push({ lane: free, color: nextColors[free], dashed, seg: nextSegs[free] });
    });

    // Compact: drop free lanes, remember where each lane moved.
    const map: number[] = [];
    const compacted: (string | null)[] = [];
    const compactedColors: number[] = [];
    const compactedSegs: number[] = [];
    for (let j = 0; j < next.length; j++) {
      if (next[j] !== null) {
        map[j] = compacted.length;
        compacted.push(next[j]);
        compactedColors.push(nextColors[j]);
        compactedSegs.push(nextSegs[j]);
      } else map[j] = -1;
    }

    const edges: GraphEdge[] = [];
    // Top half: lanes from the row above.
    for (let j = 0; j < before; j++) {
      const h = lanes[j];
      if (h === null) continue;
      if (h === hash) {
        if (!isNewLane || j !== nodeLane) edges.push({ fromLane: j, fromY: 0, toLane: nodeLane, toY: 1, color: colors[j], seg: segs[j] });
      } else {
        // Pass-through lane (shifted when lanes to the left were freed).
        edges.push({ fromLane: j, fromY: 0, toLane: map[j], toY: 2, color: colors[j], seg: segs[j] });
      }
    }
    // Bottom half: from the node to each parent lane.
    for (const t of parentTargets) {
      edges.push({ fromLane: nodeLane, fromY: 1, toLane: map[t.lane], toY: 2, color: t.color, dashed: t.dashed || undefined, seg: t.seg });
    }

    this.lanes = compacted;
    this.laneColors = compactedColors;
    this.laneSegs = compactedSegs;
    this.row++;
    const width = Math.max(before, lanes.length, compacted.length, nodeLane + 1);
    return { lane: nodeLane, color: nodeColor, edges, width, top, bottom: compactedSegs.slice() };
  }
}

/** IntelliJ PrintElementGeneratorImpl constants. */
export const LONG_EDGE_SIZE = 30;
const LONG_EDGE_PART_SIZE = 1;
const VERY_LONG_EDGE_SIZE = 1000;
const VERY_LONG_EDGE_PART_SIZE = 250;

/**
 * Hides the middle of long edges, like IntelliJ's PrintElementGeneratorImpl: an edge spanning
 * LONG_EDGE_SIZE rows or more is only drawn next to its commits, ending in arrows, and the lanes it
 * frees are compacted. With "Long Edges" shown, only very long edges are cut and long ones get arrows.
 * An edge whose parent is not loaded yet counts as long once it spans enough rows.
 */
export function visualizeRow(raw: GraphRow, rowIndex: number, segments: Segment[], showLongEdges: boolean): GraphRow {
  if (!raw.top || !raw.bottom) return raw;
  const longSize = showLongEdges ? VERY_LONG_EDGE_SIZE : LONG_EDGE_SIZE;
  const part = showLongEdges ? VERY_LONG_EDGE_PART_SIZE : LONG_EDGE_PART_SIZE;
  const arrowSize = showLongEdges ? LONG_EDGE_SIZE : Number.MAX_SAFE_INTEGER;
  const endOf = (seg: Segment) => seg.end ?? Number.MAX_SAFE_INTEGER;
  const visibleInRow = (id: number | undefined, r: number) => {
    if (id === undefined || id < 0) return true;
    const seg = segments[id];
    if (!seg || endOf(seg) - seg.start < longSize) return true;
    return Math.min(r - seg.start, endOf(seg) - r) <= part;
  };
  // A lane has a position on the boundary between two rows when its edge is drawn in both rows.
  const rank = (vis: boolean[]) => {
    const pos: number[] = [];
    let count = 0;
    vis.forEach((v, j) => (pos[j] = v ? count++ : -1));
    return { pos, count };
  };
  const topRank = rank(raw.top.map((id, j) => j === raw.lane || id < 0 || (visibleInRow(id, rowIndex - 1) && visibleInRow(id, rowIndex))));
  const bottomRank = rank(raw.bottom.map(id => id < 0 || (visibleInRow(id, rowIndex) && visibleInRow(id, rowIndex + 1))));
  const nodePos = topRank.pos[raw.lane] ?? 0;
  const edges: GraphEdge[] = [];
  for (let e of raw.edges) {
    if (!visibleInRow(e.seg, rowIndex)) continue;
    const seg = e.seg !== undefined && e.seg >= 0 ? segments[e.seg] : undefined;
    let arrow: 'down' | 'up' | undefined;
    if (seg) {
      const size = endOf(seg) - seg.start;
      const upOffset = rowIndex - seg.start;
      const downOffset = endOf(seg) - rowIndex;
      if (size >= longSize) {
        if (upOffset === part) arrow = 'down';
        else if (downOffset === part) arrow = 'up';
      }
      if (!arrow && size >= arrowSize) {
        if (upOffset === 1) arrow = 'down';
        else if (downOffset === 1) arrow = 'up';
      }
    }
    const jump = arrow ? (arrow === 'down' ? seg!.to : seg!.from) : undefined;
    if (seg?.collapsed) e = { ...e, dashed: true };
    const from = e.fromY === 0 ? topRank.pos[e.fromLane] : nodePos;
    const to = e.toY === 2 ? bottomRank.pos[e.toLane] : nodePos;
    if (e.fromY === 0 && e.toY === 2 && to < 0 && from >= 0) {
      // Stub below the child: from the top boundary down to the middle of the row.
      edges.push({ ...e, fromLane: from, toLane: from, toY: 1, arrow: 'down', jump: seg?.to });
      continue;
    }
    if (e.fromY === 0 && e.toY === 2 && from < 0 && to >= 0) {
      // Stub above the parent: from the middle of the row to the bottom boundary.
      edges.push({ ...e, fromLane: to, fromY: 1, toLane: to, arrow: 'up', jump: seg?.from });
      continue;
    }
    if (from < 0 || to < 0) continue;
    edges.push({ ...e, fromLane: from, toLane: to, arrow, jump });
  }
  return { lane: nodePos, color: raw.color, edges, width: Math.max(topRank.count, bottomRank.count, nodePos + 1) };
}

/**
 * Port of IntelliJ's DefaultColorGenerator.calcColor: color for a graph color id, as CSS rgb().
 * `saturation` / `brightness` come from VersionControl.Log.Graph.* (0.6 / 0.6 dark, 0.6 / 0.7 light).
 */
export function graphColor(colorId: number, saturation: number, brightness: number): string {
  const rangeFix = (n: number) => Math.abs(n % 100) + 70;
  const r = rangeFix(colorId * 200 + 30);
  const g = rangeFix(colorId * 130 + 50);
  const b = rangeFix(colorId * 90 + 100);
  const hue = rgbToHue(r, g, b);
  const [rr, gg, bb] = hsbToRgb(hue, saturation, brightness);
  return `rgb(${rr},${gg},${bb})`;
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const rc = (max - r) / d;
  const gc = (max - g) / d;
  const bc = (max - b) / d;
  let h: number;
  if (r === max) h = bc - gc;
  else if (g === max) h = 2 + rc - bc;
  else h = 4 + gc - rc;
  h /= 6;
  if (h < 0) h += 1;
  return h;
}

/** java.awt.Color.HSBtoRGB */
function hsbToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
  if (saturation === 0) {
    const v = Math.floor(brightness * 255 + 0.5);
    return [v, v, v];
  }
  const h = (hue - Math.floor(hue)) * 6;
  const f = h - Math.floor(h);
  const p = brightness * (1 - saturation);
  const q = brightness * (1 - saturation * f);
  const t = brightness * (1 - saturation * (1 - f));
  let r = 0;
  let g = 0;
  let b = 0;
  switch (Math.floor(h)) {
    case 0:
      [r, g, b] = [brightness, t, p];
      break;
    case 1:
      [r, g, b] = [q, brightness, p];
      break;
    case 2:
      [r, g, b] = [p, brightness, t];
      break;
    case 3:
      [r, g, b] = [p, q, brightness];
      break;
    case 4:
      [r, g, b] = [t, p, brightness];
      break;
    case 5:
      [r, g, b] = [brightness, p, q];
      break;
  }
  return [Math.floor(r * 255 + 0.5), Math.floor(g * 255 + 0.5), Math.floor(b * 255 + 0.5)];
}
