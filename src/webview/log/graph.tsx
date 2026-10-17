import { graphColor } from '../../git/graph';
import type { GraphRow } from '../../shared/types';

export const LANE = 14;
export const ROW_H = 26;
const R = 3.6;

let cache = new Map<number, string>();
let sat = 0.6;
let bri = 0.6;

/** Re-reads VersionControl.Log.Graph saturation / brightness from the theme. Call after a theme change. */
export function updateGraphTheme() {
  const style = getComputedStyle(document.body);
  sat = parseFloat(style.getPropertyValue('--graph-saturation')) || 0.6;
  bri = parseFloat(style.getPropertyValue('--graph-brightness')) || 0.6;
  cache = new Map();
}

/** Graph color for a color id (IntelliJ DefaultColorGenerator). */
export function laneColor(id: number): string {
  let c = cache.get(id);
  if (!c) cache.set(id, (c = graphColor(id, sat, bri)));
  return c;
}

const x = (lane: number) => lane * LANE + LANE / 2 + 2;
const y = (v: number) => (v * ROW_H) / 2;

export function GraphCell({ row, width, head }: { row: GraphRow; width: number; head?: boolean }) {
  return (
    <svg class="graph" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`}>
      {row.edges.map((e, i) => (
        <line
          key={i}
          x1={x(e.fromLane)}
          y1={y(e.fromY)}
          x2={x(e.toLane)}
          y2={y(e.toY)}
          stroke={laneColor(e.color)}
          stroke-width={1.6}
          stroke-dasharray={e.dashed ? '2 2' : undefined}
          stroke-linecap="round"
        />
      ))}
      <circle cx={x(row.lane)} cy={ROW_H / 2} r={head ? R + 0.8 : R} fill={laneColor(row.color)} />
      {head && <circle cx={x(row.lane)} cy={ROW_H / 2} r={R - 1.4} fill="var(--bg)" />}
    </svg>
  );
}

export function graphWidth(lanes: number) {
  return Math.max(1, lanes) * LANE + 6;
}
