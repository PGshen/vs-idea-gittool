// Three-way merge model shared by the host, the merge webview and tests. Keep it free of non-shared imports.
// Port of the ideas in IntelliJ's ComparisonMergeUtil / MergeLineFragment: base -> left and base -> right
// line diffs are combined into merge chunks; a chunk changed on both sides differently is a conflict.

import { diffLines, DiffBlock } from './lineDiff';

/**
 * - left / right: changed on one side only (non-conflicting change)
 * - both: changed identically on both sides (non-conflicting)
 * - conflict: changed differently on both sides
 */
export type ChunkType = 'left' | 'right' | 'both' | 'conflict';

/** Line ranges [x0, x1) in the base, left and right texts. */
export interface MergeChunk {
  base: [number, number];
  left: [number, number];
  right: [number, number];
  type: ChunkType;
  /** Conflict that the "Resolve Simple Conflicts" magic wand can resolve; the resolved lines. */
  resolved?: string[];
}

/** IntelliJ's "Ignore" diff setting. */
export type IgnorePolicy = 'none' | 'trim' | 'whitespace';

export function normalizer(p: IgnorePolicy): (s: string) => string {
  if (p === 'trim') return s => s.trim();
  if (p === 'whitespace') return s => s.replace(/\s+/g, '');
  return s => s;
}

/** Kind of change of one side relative to the base, for coloring (IntelliJ TextDiffType). */
export type SideKind = 'inserted' | 'deleted' | 'modified' | 'conflict' | 'none';

export function sideKind(c: MergeChunk, side: 'left' | 'right'): SideKind {
  if (c.type === 'conflict') return 'conflict';
  if (c.type !== 'both' && c.type !== side) return 'none';
  const [b0, b1] = c.base;
  const [s0, s1] = c[side];
  if (b0 === b1) return 'inserted';
  if (s0 === s1) return 'deleted';
  return 'modified';
}

interface Tagged extends DiffBlock {
  side: 'left' | 'right';
}

/**
 * Builds merge chunks. Changes of the two sides whose base ranges intersect or touch form one chunk
 * (like git, touching changes are a conflict unless they are identical or the magic resolve can merge them).
 */
export function buildMergeChunks(base: string[], left: string[], right: string[], ignore: IgnorePolicy = 'none'): MergeChunk[] {
  const n = normalizer(ignore);
  const nb = base.map(n);
  const nl = left.map(n);
  const nr = right.map(n);
  const lb = diffLines(nb, nl).map(b => ({ ...b, side: 'left' as const }));
  const rb = diffLines(nb, nr).map(b => ({ ...b, side: 'right' as const }));
  const all: Tagged[] = [...lb, ...rb].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const groups: Tagged[][] = [];
  let cur: Tagged[] = [];
  let curEnd = -1;
  for (const b of all) {
    if (cur.length && overlaps(b, cur, curEnd)) {
      cur.push(b);
      curEnd = Math.max(curEnd, b.a1);
    } else {
      if (cur.length) groups.push(cur);
      cur = [b];
      curEnd = b.a1;
    }
  }
  if (cur.length) groups.push(cur);

  const chunks: MergeChunk[] = [];
  for (const g of groups) {
    const b0 = Math.min(...g.map(b => b.a0));
    const b1 = Math.max(...g.map(b => b.a1));
    const l = sideRange(lb, g, b0, b1);
    const r = sideRange(rb, g, b0, b1);
    const hasL = g.some(b => b.side === 'left');
    const hasR = g.some(b => b.side === 'right');
    let type: ChunkType;
    if (hasL && hasR) {
      const lt = nl.slice(l[0], l[1]);
      const rt = nr.slice(r[0], r[1]);
      type = lt.length === rt.length && lt.every((s, i) => s === rt[i]) ? 'both' : 'conflict';
    } else type = hasL ? 'left' : 'right';
    const chunk: MergeChunk = { base: [b0, b1], left: l, right: r, type };
    if (type === 'conflict') {
      const resolved = resolveSimple(base.slice(b0, b1), left.slice(l[0], l[1]), right.slice(r[0], r[1]), n);
      if (resolved) chunk.resolved = resolved;
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** Touching or intersecting base ranges. Two insertions at the same base line also overlap. */
function overlaps(b: Tagged, cur: Tagged[], curEnd: number): boolean {
  if (b.a0 < curEnd) return true;
  if (b.a0 === curEnd) {
    // Touching ranges are grouped only when the other side is involved (same-side blocks never touch).
    return cur.some(c => c.side !== b.side);
  }
  return false;
}

/** Maps a group's base range to the side's range: shift by the blocks before it, extend by the blocks inside. */
function sideRange(blocks: DiffBlock[], group: DiffBlock[], b0: number, b1: number): [number, number] {
  let before = 0;
  let inside = 0;
  for (const b of blocks) {
    const d = b.b1 - b.b0 - (b.a1 - b.a0);
    if (group.includes(b)) inside += d;
    else if (b.a1 <= b0) before += d;
  }
  return [b0 + before, b1 + before + inside];
}

/**
 * IntelliJ's "Resolve Simple Conflicts": the conflict is resolvable when the line changes of the two
 * sides inside the chunk do not intersect (they only touch). Returns the merged lines, or undefined.
 */
export function resolveSimple(base: string[], left: string[], right: string[], n: (s: string) => string = s => s): string[] | undefined {
  const lb = diffLines(base.map(n), left.map(n));
  const rb = diffLines(base.map(n), right.map(n));
  for (const x of lb) {
    for (const y of rb) {
      const intersect = x.a0 < y.a1 && y.a0 < x.a1;
      const sameInsertPoint = x.a0 === x.a1 && y.a0 === y.a1 && x.a0 === y.a0;
      const insertInside = (x.a0 === x.a1 && x.a0 > y.a0 && x.a0 < y.a1) || (y.a0 === y.a1 && y.a0 > x.a0 && y.a0 < x.a1);
      if (intersect || sameInsertPoint || insertInside) return undefined;
    }
  }
  // Apply both block lists to the base, from the end so indexes stay valid.
  const edits = [...lb.map(b => ({ b, src: left })), ...rb.map(b => ({ b, src: right }))].sort((p, q) => q.b.a0 - p.b.a0 || q.b.a1 - p.b.a1);
  const out = base.slice();
  for (const { b, src } of edits) out.splice(b.a0, b.a1 - b.a0, ...src.slice(b.b0, b.b1));
  return out;
}

/** Text of a line range, with a trailing newline per line (empty string for an empty range). */
export function rangeText(lines: string[], range: [number, number]): string {
  const [a, b] = range;
  return a === b ? '' : lines.slice(a, b).join('\n') + '\n';
}

/** Splits text into lines keeping track of whether it ends with a newline. */
export function toLines(text: string): { lines: string[]; eol: string; trailingNewline: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text === '' || /\r?\n$/.test(text);
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  return { lines, eol, trailingNewline };
}

export interface MergeStats {
  changes: number;
  conflicts: number;
}

/** IntelliJ's status text: "2 changes, 1 conflict" / "No changes, No conflicts". */
export function statusText(s: MergeStats): string {
  const ch = s.changes === 0 ? 'No changes' : s.changes === 1 ? '1 change' : `${s.changes} changes`;
  const co = s.conflicts === 0 ? 'No conflicts' : s.conflicts === 1 ? '1 conflict' : `${s.conflicts} conflicts`;
  return `${ch}, ${co}`;
}

/** IntelliJ's "There are 2 changes and one conflict left unprocessed.\nSave changes and mark the conflict resolved anyway?" */
export function unprocessedMessage(s: MergeStats): string {
  const verb = s.changes === 1 || (s.changes === 0 && s.conflicts === 1) ? 'is' : 'are';
  const ch = s.changes === 0 ? '' : s.changes === 1 ? 'one change' : `${s.changes} changes`;
  const and = s.changes > 0 && s.conflicts > 0 ? ' and ' : '';
  const co = s.conflicts === 0 ? '' : s.conflicts === 1 ? 'one conflict' : `${s.conflicts} conflicts`;
  return `There ${verb} ${ch}${and}${co} left unprocessed.\nSave changes and mark the conflict resolved anyway?`;
}
