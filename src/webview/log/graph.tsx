import { graphColor } from '../../git/graph';
import type { GraphEdge, GraphRow } from '../../shared/types';
import { t } from '../lib/l10n';
import { theme } from '../lib/rpc';

export const LANE = 14;
export const ROW_H = 26;
const R = 3.6;
const ARROW = 3.5;

let cache = new Map<number, string>();
let sat = 0.6;
let bri = 0.6;

/**
 * Re-reads VersionControl.Log.Graph saturation / brightness from the theme. Call after a theme change.
 * The "vscode" appearance does not set them, so it gets the IntelliJ dark / light values by theme kind.
 */
export function updateGraphTheme() {
  const style = getComputedStyle(document.body);
  sat = parseFloat(style.getPropertyValue('--graph-saturation')) || 0.6;
  bri = parseFloat(style.getPropertyValue('--graph-brightness')) || (theme.dark ? 0.6 : 0.7);
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

/** Arrow head of a long edge stub (EdgePrintElement.Type.DOWN / UP). */
function arrowPath(e: GraphEdge): string {
  const through = e.fromY === 0 && e.toY === 2;
  // Stubs end (down) or start (up) at the middle of the row; full edges get the arrow at their middle.
  const ax = through ? (x(e.fromLane) + x(e.toLane)) / 2 : e.arrow === 'down' ? x(e.toLane) : x(e.fromLane);
  const tip = through ? ROW_H / 2 + (e.arrow === 'down' ? ARROW / 2 : -ARROW / 2) : e.arrow === 'down' ? y(e.toY) : y(e.fromY);
  const back = e.arrow === 'down' ? tip - ARROW : tip + ARROW;
  return `M ${ax - ARROW} ${back} L ${ax} ${tip} L ${ax + ARROW} ${back}`;
}

export function GraphCell({ row, width, head, onJump }: { row: GraphRow; width: number; head?: boolean; onJump?: (hash: string, toParent: boolean) => void }) {
  return (
    <svg class="graph" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`}>
      {row.edges.map((e, i) => {
        const color = laneColor(e.color);
        const line = (
          <line
            x1={x(e.fromLane)}
            y1={y(e.fromY)}
            x2={x(e.toLane)}
            y2={y(e.toY)}
            stroke={color}
            stroke-width={1.6}
            stroke-dasharray={e.dashed ? '2 2' : undefined}
            stroke-linecap="round"
          />
        );
        if (!e.arrow) return <g key={i}>{line}</g>;
        return (
          <g
            key={i}
            class="graph-arrow"
            onMouseDown={ev => ev.stopPropagation()}
            onClick={ev => {
              ev.stopPropagation();
              if (e.jump) onJump?.(e.jump, e.arrow === 'down');
            }}
          >
            <title>{e.arrow === 'down' ? t('Jump to Parent') : t('Jump to Child')}</title>
            <rect x={Math.min(x(e.fromLane), x(e.toLane)) - 5} y={0} width={Math.abs(x(e.toLane) - x(e.fromLane)) + 10} height={ROW_H} fill="transparent" />
            {line}
            <path d={arrowPath(e)} stroke={color} stroke-width={1.6} fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </g>
        );
      })}
      <circle cx={x(row.lane)} cy={ROW_H / 2} r={head ? R + 0.8 : R} fill={laneColor(row.color)} />
      {head && <circle cx={x(row.lane)} cy={ROW_H / 2} r={R - 1.4} fill="var(--bg)" />}
    </svg>
  );
}

export function graphWidth(lanes: number) {
  return Math.max(1, lanes) * LANE + 6;
}
