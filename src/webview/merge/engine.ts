import { invertedEffects } from '@codemirror/commands';
import { ChangeSet, EditorState, Extension, RangeSet, RangeSetBuilder, StateEffect, StateField, Text } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, GutterMarker, WidgetType } from '@codemirror/view';
import { ChangeState, LineEdit, MergeChange, MergeModel } from '../../shared/mergeModel';

// ---------------------------------------------------------------- model state in the result editor

export interface ModelValue {
  states: ChangeState[];
  contentModified: boolean;
}

export const setModel = StateEffect.define<ModelValue>();

function countNewlines(s: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Merge model state of the result editor. Merge commands set it explicitly (`setModel`); edits typed by
 * the user move the change ranges with IntelliJ's rules (MergeModelBase.DocumentListener). Every change of
 * the value is part of the undo history, so undo / redo restore the resolved flags together with the text.
 */
export function modelExtension(changes: MergeChange[], initial: ModelValue, sides: MergeModel['sides']): Extension {
  const field = StateField.define<ModelValue>({
    create: () => initial,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setModel)) return e.value;
      if (!tr.docChanged) return value;
      const model = new MergeModel(
        changes,
        sides,
        [],
        value.states.map(s => ({ ...s })),
      );
      const edits: { line1: number; line2: number; shift: number }[] = [];
      const doc = tr.startState.doc;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const line1 = doc.lineAt(fromA).number - 1;
        const line2 = doc.lineAt(toA).number;
        const shift = countNewlines(inserted.toString()) - countNewlines(doc.sliceString(fromA, toA));
        edits.push({ line1, line2, shift });
      });
      for (const e of edits.reverse()) model.onUserEdit(e.line1, e.line2, e.shift);
      return { states: model.states, contentModified: value.contentModified };
    },
  });
  modelFieldRef = field;
  const invert = invertedEffects.of(tr => {
    const before = tr.startState.field(field, false);
    const after = tr.state.field(field, false);
    return before && before !== after ? [setModel.of(before)] : [];
  });
  return [field, invert];
}

let modelFieldRef: StateField<ModelValue> | undefined;

export function modelValue(state: EditorState): ModelValue {
  return state.field(modelFieldRef!);
}

/** Builds a MergeModel from the result editor (a snapshot; changes to it do not touch the editor). */
export function modelOf(view: EditorView, changes: MergeChange[], sides: MergeModel['sides']): MergeModel {
  const v = modelValue(view.state);
  const m = new MergeModel(
    changes,
    sides,
    view.state.doc.toString().split('\n'),
    v.states.map(s => ({ ...s })),
  );
  m.contentModified = v.contentModified;
  return m;
}

/** Converts one line edit of `lines` into a character change (DiffUtil.applyModification). */
export function lineEditToChange(lines: string[], e: LineEdit): { from: number; to: number; insert: string } | undefined {
  const offsets: number[] = [];
  let o = 0;
  for (const l of lines) {
    offsets.push(o);
    o += l.length + 1;
  }
  const docLen = o - 1;
  const lineEnd = (i: number) => offsets[i] + lines[i].length;
  const { start, end } = e;
  const n = lines.length;
  if (start === end && e.lines.length === 0) return undefined;
  if (start === end) {
    if (start >= n) return { from: docLen, to: docLen, insert: '\n' + e.lines.join('\n') };
    return { from: offsets[start], to: offsets[start], insert: e.lines.join('\n') + '\n' };
  }
  if (e.lines.length === 0) {
    let from = offsets[start];
    let to = lineEnd(end - 1);
    if (from > 0) from--;
    else if (to < docLen) to++;
    return { from, to, insert: '' };
  }
  return { from: offsets[start], to: lineEnd(end - 1), insert: e.lines.join('\n') };
}

/**
 * Runs a merge command (MergeThreesideViewer.executeMergeCommand) on a snapshot of the model and applies
 * the resulting text edits and state to the result editor in one undoable transaction.
 */
export function runCommand(view: EditorView, changes: MergeChange[], sides: MergeModel['sides'], fn: (m: MergeModel) => void): MergeModel {
  const model = modelOf(view, changes, sides);
  const lines = model.lines.slice();
  fn(model);
  const edits = model.takeEdits();
  let cs = ChangeSet.empty(view.state.doc.length);
  for (const e of edits) {
    const ch = lineEditToChange(lines, e);
    lines.splice(e.start, e.end - e.start, ...e.lines);
    if (lines.length === 0) lines.push('');
    if (!ch) continue;
    cs = cs.compose(ChangeSet.of([ch], cs.newLength));
  }
  view.dispatch({
    changes: cs,
    effects: setModel.of({ states: model.states, contentModified: model.contentModified }),
    userEvent: 'input.merge',
    scrollIntoView: false,
  });
  return model;
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

export type Kind = 'inserted' | 'deleted' | 'modified' | 'conflict';

export interface Region {
  /** 0-based line range [l0, l1) in this editor. */
  l0: number;
  l1: number;
  kind: Kind;
  /** Resolved: drawn with a dotted border only (DiffDrawUtil.PaintMode.RESOLVED). */
  resolved: boolean;
  /** Word-level ranges as character offsets relative to the region's text. */
  inner?: [number, number][];
}

/**
 * Line and word decorations for a list of regions (DiffDrawUtil.LineHighlighterBuilder):
 * full background without inner fragments, the lighter "ignored" background with them, a dotted frame
 * when resolved, and a separator line for empty ranges.
 */
export function buildDecorations(doc: Text, regions: Region[], highlight: 'words' | 'lines' | 'none'): DecorationSet {
  const items: { from: number; to: number; deco: Decoration }[] = [];
  for (const r of regions) {
    if (highlight === 'none' && r.kind !== 'conflict' && !r.resolved) continue;
    if (r.l0 === r.l1) {
      const atTop = r.l0 === 0;
      const lineNo = atTop ? 1 : Math.min(doc.lines, r.l0);
      const line = doc.line(lineNo);
      const cls = `mg-${r.kind} ${atTop ? 'mg-sep-top' : 'mg-sep-bottom'} ${r.resolved ? 'mg-resolved' : ''}`;
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls }) });
      continue;
    }
    const withInner = highlight === 'words' && !r.resolved && r.inner !== undefined;
    for (let n = r.l0; n < r.l1 && n < doc.lines; n++) {
      const line = doc.line(n + 1);
      const cls = [`mg-${r.kind}`, 'mg-line'];
      if (r.resolved) cls.push('mg-resolved');
      else if (withInner) cls.push('mg-ignored');
      if (n === r.l0) cls.push('mg-first');
      if (n === r.l1 - 1) cls.push('mg-last');
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls.join(' ') }) });
    }
    if (withInner && r.inner!.length && r.l0 < doc.lines) {
      const start = doc.line(r.l0 + 1).from;
      for (const [a, z] of r.inner!) {
        const from = Math.min(doc.length, start + a);
        const to = Math.min(doc.length, start + z);
        if (to > from) items.push({ from, to, deco: Decoration.mark({ class: `mg-inner-${r.kind}` }) });
      }
    }
  }
  items.sort((x, y) => x.from - y.from || (x.to === x.from ? -1 : 0) - (y.to === y.from ? -1 : 0) || x.to - y.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const it of items) b.add(it.from, it.to, it.deco);
  return b.finish();
}

// ---------------------------------------------------------------- gutter: change backgrounds and operations

class LineClassMarker extends GutterMarker {
  constructor(readonly cls: string) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof LineClassMarker && other.cls === this.cls;
  }
}

export const setGutterClasses = StateEffect.define<RangeSet<GutterMarker>>();

/** Gutter line classes: IntelliJ colors the gutter of changed lines (DiffLineMarkerRenderer). */
export const gutterClassField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGutterClasses)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

export function gutterClasses(doc: Text, regions: Region[]): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  const items: { pos: number; cls: string }[] = [];
  for (const r of regions) {
    if (r.l0 === r.l1 || r.resolved) continue;
    for (let n = r.l0; n < r.l1 && n < doc.lines; n++) {
      items.push({ pos: doc.line(n + 1).from, cls: `mg-g-${r.kind}${n === r.l0 ? ' mg-g-first' : ''}${n === r.l1 - 1 ? ' mg-g-last' : ''}` });
    }
  }
  items.sort((a, b) => a.pos - b.pos);
  let last = -1;
  for (const it of items) {
    if (it.pos === last) continue;
    last = it.pos;
    b.add(it.pos, it.pos, new LineClassMarker(it.cls));
  }
  return b.finish();
}

/** One gutter operation icon (DiffGutterOperation / DiffGutterRenderer). */
export interface Operation {
  /** Change index. */
  i: number;
  action: 'apply' | 'ignore' | 'resolve';
  side: 'left' | 'right' | 'result';
  icon: string;
  tooltip: string;
}

export class OperationsMarker extends GutterMarker {
  constructor(
    readonly ops: Operation[],
    readonly iconUrl: (icon: string) => string,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof OperationsMarker && JSON.stringify(other.ops) === JSON.stringify(this.ops) && other.iconUrl === this.iconUrl;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = 'mg-ops';
    for (const op of this.ops) {
      const b = document.createElement('span');
      b.className = 'mg-op';
      b.dataset.i = String(op.i);
      b.dataset.action = op.action;
      b.dataset.side = op.side;
      b.dataset.tip = op.tooltip;
      const img = document.createElement('img');
      img.src = this.iconUrl(op.icon);
      img.width = 14;
      img.height = 14;
      img.draggable = false;
      b.appendChild(img);
      el.appendChild(b);
    }
    return el;
  }
}

export const setOperations = StateEffect.define<RangeSet<GutterMarker>>();

export const operationsField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOperations)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

// ---------------------------------------------------------------- folding of unchanged fragments

/** A collapsed unchanged fragment (FoldingModelSupport): lines [l0, l1) of one editor, `group` shared by the three editors. */
export interface Fold {
  l0: number;
  l1: number;
  group: number;
}

class FoldWidget extends WidgetType {
  constructor(
    readonly group: number,
    readonly count: number,
  ) {
    super();
  }
  override eq(other: FoldWidget) {
    return other.group === this.group && other.count === this.count;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = 'mg-fold';
    el.dataset.group = String(this.group);
    el.dataset.tip = 'Click to expand';
    const line = document.createElement('span');
    line.className = 'mg-fold-line';
    el.appendChild(line);
    return el;
  }
  override ignoreEvent() {
    return false;
  }
}

export const setFolds = StateEffect.define<DecorationSet>();

export const foldField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFolds)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: f => EditorView.decorations.from(f),
});

export function buildFolds(doc: Text, folds: Fold[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const f of [...folds].sort((a, z) => a.l0 - z.l0)) {
    if (f.l1 <= f.l0 || f.l1 > doc.lines) continue;
    const from = doc.line(f.l0 + 1).from;
    const to = doc.line(f.l1).to;
    b.add(from, to, Decoration.replace({ block: true, widget: new FoldWidget(f.group, f.l1 - f.l0) }));
  }
  return b.finish();
}
