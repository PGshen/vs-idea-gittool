import type { DiffHunk } from '../../shared/logProtocol';

// Alignment of unified diff hunks for the side-by-side / unified diff preview.

export type Kind = 'equal' | 'inserted' | 'deleted' | 'modified';

/** One visual line of the side-by-side viewer. Missing sides are fillers. */
export interface SideRow {
  kind: Kind;
  left?: { n: number; s: string };
  right?: { n: number; s: string };
  /** Index of the change block, for previous / next difference navigation. */
  block?: number;
}

export interface Gap {
  gap: number;
  /** Line numbers of the first hidden line on both sides. */
  oldFrom: number;
  newFrom: number;
}

export type Item = SideRow | Gap;

export const isGap = (i: Item): i is Gap => (i as Gap).gap !== undefined;

/** Builds aligned rows from unified hunks; runs of removed + added lines are paired as modifications. */
export function alignHunks(hunks: DiffHunk[], oldTotal: number, newTotal: number): { items: Item[]; blocks: number } {
  const items: Item[] = [];
  let oldLine = 1;
  let newLine = 1;
  let blocks = 0;
  for (const h of hunks) {
    const skipped = h.oldStart - oldLine;
    if (skipped > 0) items.push({ gap: skipped, oldFrom: oldLine, newFrom: newLine });
    oldLine = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    newLine = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    let i = 0;
    while (i < h.lines.length) {
      const l = h.lines[i];
      if (l.t === ' ') {
        items.push({ kind: 'equal', left: { n: oldLine++, s: l.s }, right: { n: newLine++, s: l.s } });
        i++;
        continue;
      }
      const removed: string[] = [];
      const added: string[] = [];
      while (i < h.lines.length && h.lines[i].t === '-') removed.push(h.lines[i++].s);
      while (i < h.lines.length && h.lines[i].t === '+') added.push(h.lines[i++].s);
      const kind: Kind = removed.length && added.length ? 'modified' : removed.length ? 'deleted' : 'inserted';
      const block = blocks++;
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        items.push({
          kind,
          block,
          left: k < removed.length ? { n: oldLine++, s: removed[k] } : undefined,
          right: k < added.length ? { n: newLine++, s: added[k] } : undefined,
        });
      }
    }
  }
  const tail = Math.max(oldTotal - oldLine + 1, newTotal - newLine + 1);
  if (hunks.length && tail > 0) items.push({ gap: tail, oldFrom: oldLine, newFrom: newLine });
  return { items, blocks };
}

/** Common prefix / suffix of two lines, by word, for the inline highlighting of modified lines. */
export function innerRange(a: string, b: string): [number, number, number, number] {
  const tokens = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const ta = tokens(a);
  const tb = tokens(b);
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let q = 0;
  while (q < ta.length - p && q < tb.length - p && ta[ta.length - 1 - q] === tb[tb.length - 1 - q]) q++;
  const len = (list: string[], from: number, to: number) => list.slice(from, to).join('').length;
  const aStart = len(ta, 0, p);
  const bStart = len(tb, 0, p);
  return [aStart, a.length - len(ta, ta.length - q, ta.length), bStart, b.length - len(tb, tb.length - q, tb.length)];
}

