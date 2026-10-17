import { EditorState, Extension, RangeSetBuilder, StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { invertedEffects } from '@codemirror/commands';
import { diffLines } from '../../shared/lineDiff';
import { MergeChunk, sideKind, SideKind } from '../../shared/mergeModel';

/** Resolution state of one chunk: which sides were handled (applied or ignored). */
export interface ChunkState {
  /** Character range of the chunk in the result document (whole lines). */
  from: number;
  to: number;
  l: boolean;
  r: boolean;
  /** Side whose content is currently in the result for a conflict (append goes after it). */
  applied?: 'left' | 'right';
}

export function isResolved(c: MergeChunk, s: ChunkState): boolean {
  switch (c.type) {
    case 'left':
      return s.l;
    case 'right':
      return s.r;
    case 'both':
      return s.l || s.r;
    case 'conflict':
      return s.l && s.r;
  }
}

/** Whether a side still offers its apply / ignore controls for the chunk. */
export function sideActive(c: MergeChunk, s: ChunkState, side: 'left' | 'right'): boolean {
  if (isResolved(c, s)) return false;
  if (sideKind(c, side) === 'none') return false;
  return side === 'left' ? !s.l : !s.r;
}

const setStates = StateEffect.define<{ i: number; state: ChunkState }[]>();

/** Chunk states of the result editor, mapped through edits; part of undo history. */
export const chunkField = StateField.define<ChunkState[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (!tr.changes.empty) {
      next = value.map(s => {
        const from = tr.changes.mapPos(s.from, -1);
        const to = Math.max(from, tr.changes.mapPos(s.to, 1));
        return { ...s, from, to };
      });
    }
    for (const e of tr.effects) {
      if (e.is(setStates)) {
        if (next === value) next = value.slice();
        for (const { i, state } of e.value) next[i] = state;
      }
    }
    return next;
  },
});

/** Undo / redo restores chunk states together with the text. */
const invertStates = invertedEffects.of(tr => {
  const out: StateEffect<unknown>[] = [];
  const before = tr.startState.field(chunkField, false);
  if (!before) return out;
  for (const e of tr.effects) {
    if (e.is(setStates)) {
      // Before-states are in start-document positions, which is the document again after the undo.
      out.push(setStates.of(e.value.map(({ i }) => ({ i, state: before[i] }))));
    }
  }
  return out;
});

export function chunkExtensions(): Extension {
  return [chunkField, invertStates];
}

export function initStates(chunks: MergeChunk[], doc: Text): ChunkState[] {
  return chunks.map(c => ({ from: lineStart(doc, c.base[0]), to: lineStart(doc, c.base[1]), l: false, r: false }));
}

/** Offset of the start of line `n` (0-based); the document end when n is past the last line. */
export function lineStart(doc: Text, n: number): number {
  if (n >= doc.lines) return doc.length;
  return doc.line(n + 1).from;
}

/** 0-based line range [l0, l1) covered by a character range of whole lines. */
export function lineRange(doc: Text, from: number, to: number): [number, number] {
  const l0 = doc.lineAt(from).number - 1;
  if (to <= from) return [l0, l0];
  const l1 = to >= doc.length ? doc.lines - (doc.line(doc.lines).length === 0 ? 1 : 0) : doc.lineAt(to).number - 1;
  return [l0, Math.max(l0, l1)];
}

export interface Sides {
  left: string[];
  right: string[];
  base: string[];
}

export function linesText(lines: string[], range: [number, number]): string {
  const [a, b] = range;
  return a === b ? '' : lines.slice(a, b).map(l => l + '\n').join('');
}

/** Builds the transaction that applies (or appends) a side of chunk `i`. */
export function applySide(view: EditorView, chunks: MergeChunk[], sides: Sides, i: number, side: 'left' | 'right'): void {
  const st = view.state.field(chunkField)[i];
  const c = chunks[i];
  const text = linesText(sides[side], c[side]);
  const other = side === 'left' ? 'r' : 'l';
  const appendMode = c.type === 'conflict' && st[other] && st.applied && st.applied !== side;
  let next: ChunkState;
  let changes;
  if (appendMode) {
    changes = { from: st.to, to: st.to, insert: text };
    next = { ...st, [side === 'left' ? 'l' : 'r']: true, from: st.from, to: st.to + text.length, applied: st.applied };
  } else {
    changes = { from: st.from, to: st.to, insert: text };
    const flags = c.type === 'conflict' ? { [side === 'left' ? 'l' : 'r']: true } : { l: true, r: true };
    next = { ...st, ...flags, from: st.from, to: st.from + text.length, applied: side };
  }
  view.dispatch({ changes, effects: setStates.of([{ i, state: next }]), userEvent: 'input.merge', scrollIntoView: false });
}

/** Ignores a side of chunk `i` (IntelliJ's "×"): the result keeps its text. */
export function ignoreSide(view: EditorView, chunks: MergeChunk[], i: number, side: 'left' | 'right'): void {
  const st = view.state.field(chunkField)[i];
  const c = chunks[i];
  const flags = c.type === 'conflict' ? { [side === 'left' ? 'l' : 'r']: true } : { l: true, r: true };
  view.dispatch({ effects: setStates.of([{ i, state: { ...st, ...flags } }]), userEvent: 'input.merge' });
}

/** Magic resolve of conflict `i` with the precomputed resolution. */
export function resolveChunk(view: EditorView, chunks: MergeChunk[], i: number): void {
  const st = view.state.field(chunkField)[i];
  const lines = chunks[i].resolved;
  if (!lines) return;
  const text = lines.map(l => l + '\n').join('');
  view.dispatch({
    changes: { from: st.from, to: st.to, insert: text },
    effects: setStates.of([{ i, state: { ...st, l: true, r: true, from: st.from, to: st.from + text.length } }]),
    userEvent: 'input.merge',
  });
}

/**
 * Applies several chunks in one transaction (Apply Non-Conflicting Changes, Resolve Simple Conflicts),
 * so that one undo reverts all of them.
 */
export function applyMany(view: EditorView, chunks: MergeChunk[], sides: Sides, picks: { i: number; side: 'left' | 'right' | 'magic' }[]): void {
  if (!picks.length) return;
  const states = view.state.field(chunkField);
  const specs: { from: number; to: number; insert: string }[] = [];
  const updates: { i: number; state: ChunkState }[] = [];
  for (const p of picks) {
    const st = states[p.i];
    const c = chunks[p.i];
    const text = p.side === 'magic' ? (c.resolved ?? []).map(l => l + '\n').join('') : linesText(sides[p.side], c[p.side]);
    specs.push({ from: st.from, to: st.to, insert: text });
    updates.push({ i: p.i, state: { ...st, l: true, r: true, applied: p.side === 'magic' ? undefined : p.side } });
  }
  const cs = view.state.changes(specs);
  // Map chunk ranges through the combined change set: starts stick left, ends right after the insert.
  for (const u of updates) {
    const spec = specs[updates.indexOf(u)];
    const from = cs.mapPos(spec.from, -1);
    u.state = { ...u.state, from, to: from + spec.insert.length };
  }
  view.dispatch({ changes: cs, effects: setStates.of(updates), userEvent: 'input.merge' });
}

/** Revert Conflict Resolution: back to the base text with every change unresolved. */
export function resetAll(view: EditorView, chunks: MergeChunk[], base: string): void {
  const doc = Text.of(base.split('\n'));
  const states = initStates(chunks, doc);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: base },
    effects: setStates.of(states.map((state, i) => ({ i, state }))),
    userEvent: 'input.merge',
  });
}

export function stats(chunks: MergeChunk[], states: ChunkState[]) {
  let changes = 0;
  let conflicts = 0;
  chunks.forEach((c, i) => {
    if (!states[i] || isResolved(c, states[i])) return;
    if (c.type === 'conflict') conflicts++;
    else changes++;
  });
  return { changes, conflicts };
}

export function createResultState(doc: string, chunks: MergeChunk[], extensions: Extension[]): EditorState {
  const text = Text.of(doc.split('\n'));
  return EditorState.create({
    doc: text,
    extensions: [chunkExtensions(), chunkField.init(() => initStates(chunks, text)), ...extensions],
  });
}

// ---------------------------------------------------------------- decorations

export const setDecorations = StateEffect.define<DecorationSet>();

/** Holder for decorations computed outside the editor (merge highlighting). */
export const decorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDecorations)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: f => EditorView.decorations.from(f),
});

type Kind = SideKind | 'resolved-conflict';

export interface Region {
  /** 0-based line range [l0, l1) in this editor. */
  l0: number;
  l1: number;
  kind: Kind;
  /** Word-level ranges as character offsets relative to the region's text. */
  inner?: [number, number][];
}

/** Line and word decorations for a list of regions. Empty regions draw a line at their position. */
export function buildDecorations(doc: Text, regions: Region[], highlight: 'words' | 'lines' | 'none'): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const sorted = [...regions].sort((x, y) => x.l0 - y.l0 || x.l1 - y.l1);
  const items: { from: number; to: number; deco: Decoration }[] = [];
  for (const r of sorted) {
    if (highlight === 'none' && r.kind !== 'conflict') continue;
    if (r.l0 === r.l1) {
      // Empty side of an insertion / deletion: a line between rows.
      const atEnd = r.l0 >= doc.lines || (r.l0 === doc.lines - 1 && doc.line(doc.lines).length === 0);
      const line = doc.line(Math.min(doc.lines, atEnd ? Math.max(1, r.l0) : r.l0 + 1));
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `mg-${r.kind} ${atEnd ? 'mg-empty-after' : 'mg-empty-before'}` }) });
      continue;
    }
    for (let n = r.l0; n < r.l1 && n < doc.lines; n++) {
      const line = doc.line(n + 1);
      const cls = [`mg-${r.kind}`, 'mg-line'];
      if (n === r.l0) cls.push('mg-first');
      if (n === r.l1 - 1) cls.push('mg-last');
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls.join(' ') }) });
    }
    if (highlight === 'words' && r.inner?.length) {
      const start = doc.line(r.l0 + 1).from;
      for (const [a, z] of r.inner) {
        const from = Math.min(doc.length, start + a);
        const to = Math.min(doc.length, start + z);
        if (to > from) items.push({ from, to, deco: Decoration.mark({ class: `mg-inner-${r.kind}` }) });
      }
    }
  }
  items.sort((x, y) => x.from - y.from || (x.to === x.from ? -1 : 0) - (y.to === y.from ? -1 : 0) || x.to - y.to);
  for (const it of items) b.add(it.from, it.to, it.deco);
  return b.finish();
}

// ---------------------------------------------------------------- word-level diff

const TOKEN = /\w+|\s+|[^\w\s]/g;

/**
 * Word-level changed ranges of `a` and `b` (IntelliJ "Highlight words"), as offsets into each text.
 * Whitespace-only tokens are not highlighted.
 */
export function wordDiff(a: string, b: string): { a: [number, number][]; b: [number, number][] } {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length * tb.length > 4_000_000) return { a: [[0, a.length]], b: [[0, b.length]] };
  const blocks = diffLines(
    ta.map(t => t.s),
    tb.map(t => t.s),
  );
  const out = { a: [] as [number, number][], b: [] as [number, number][] };
  for (const bl of blocks) {
    if (bl.a1 > bl.a0) push(out.a, ta, bl.a0, bl.a1);
    if (bl.b1 > bl.b0) push(out.b, tb, bl.b0, bl.b1);
  }
  return out;
}

function tokens(s: string) {
  const out: { s: string; i: number }[] = [];
  for (const m of s.matchAll(TOKEN)) out.push({ s: m[0], i: m.index! });
  return out;
}

function push(out: [number, number][], toks: { s: string; i: number }[], t0: number, t1: number) {
  let s = t0;
  let e = t1;
  while (s < e && /^\s+$/.test(toks[s].s)) s++;
  while (e > s && /^\s+$/.test(toks[e - 1].s)) e--;
  if (s < e) out.push([toks[s].i, toks[e - 1].i + toks[e - 1].s.length]);
}

export type { Transaction };
