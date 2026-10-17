import { GraphEdge, GraphRow } from '../shared/types';

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
  private nextColor = 0;
  /** Hashes present in the loaded log, used to draw edges to filtered out parents as dashed. */
  private readonly known: Set<string> | undefined;

  constructor(known?: Set<string>) {
    this.known = known;
  }

  private newColor(): number {
    return this.nextColor++;
  }

  add(hash: string, parents: string[]): GraphRow {
    const lanes = this.lanes;
    const colors = this.laneColors;
    const before = lanes.length;

    let nodeLane = lanes.indexOf(hash);
    const isNewLane = nodeLane < 0;
    if (isNewLane) {
      nodeLane = lanes.indexOf(null);
      if (nodeLane < 0) nodeLane = lanes.length;
      lanes[nodeLane] = hash;
      colors[nodeLane] = this.newColor();
    }
    const nodeColor = colors[nodeLane];

    // Next state: copy, then clear every lane that waited for this commit.
    const next = lanes.slice();
    const nextColors = colors.slice();
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === hash) next[j] = null;

    // Parents: the first one continues the node lane, others reuse an existing lane or get a new one.
    const parentTargets: { lane: number; color: number; dashed: boolean }[] = [];
    parents.forEach((p, i) => {
      const dashed = this.known !== undefined && !this.known.has(p);
      if (i === 0) {
        const existing = next.indexOf(p);
        if (existing >= 0 && existing < nodeLane) {
          // Converge into a lane on the left that already waits for the parent.
          parentTargets.push({ lane: existing, color: nextColors[existing], dashed });
        } else {
          next[nodeLane] = p;
          nextColors[nodeLane] = nodeColor;
          parentTargets.push({ lane: nodeLane, color: nodeColor, dashed });
        }
        return;
      }
      const existing = next.indexOf(p);
      if (existing >= 0) {
        parentTargets.push({ lane: existing, color: nextColors[existing], dashed });
        return;
      }
      let free = next.indexOf(null, nodeLane + 1);
      if (free < 0) free = next.length;
      next[free] = p;
      nextColors[free] = this.newColor();
      parentTargets.push({ lane: free, color: nextColors[free], dashed });
    });

    // Compact: drop free lanes, remember where each lane moved.
    const map: number[] = [];
    const compacted: (string | null)[] = [];
    const compactedColors: number[] = [];
    for (let j = 0; j < next.length; j++) {
      if (next[j] !== null) {
        map[j] = compacted.length;
        compacted.push(next[j]);
        compactedColors.push(nextColors[j]);
      } else map[j] = -1;
    }

    const edges: GraphEdge[] = [];
    // Top half: lanes from the row above.
    for (let j = 0; j < before; j++) {
      const h = lanes[j];
      if (h === null) continue;
      if (h === hash) {
        if (!isNewLane || j !== nodeLane) edges.push({ fromLane: j, fromY: 0, toLane: nodeLane, toY: 1, color: colors[j] });
      } else {
        // Pass-through lane (shifted when lanes to the left were freed).
        edges.push({ fromLane: j, fromY: 0, toLane: map[j], toY: 2, color: colors[j] });
      }
    }
    // Bottom half: from the node to each parent lane.
    for (const t of parentTargets) {
      edges.push({ fromLane: nodeLane, fromY: 1, toLane: map[t.lane], toY: 2, color: t.color, dashed: t.dashed || undefined });
    }

    this.lanes = compacted;
    this.laneColors = compactedColors;
    const width = Math.max(before, lanes.length, compacted.length, nodeLane + 1);
    return { lane: nodeLane, color: nodeColor, edges, width };
  }
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
