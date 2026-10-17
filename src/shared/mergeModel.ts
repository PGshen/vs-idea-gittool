// Three-way merge model shared by the host, the merge webview and tests. Keep it free of non-shared imports.
// Port of IntelliJ's MergeConflictModel / MergeModelBase / TextMergeChange (platform/diff-impl/.../merge)
// and MergeRangeUtil.getLineMergeType (platform/util/diff).

import { buildChanges } from './intellijDiff';
import { tryResolve } from './mergeResolve';

/** IntelliJ's "Ignore" diff setting. */
export type IgnorePolicy = 'none' | 'trim' | 'whitespace';

export function normalizer(p: IgnorePolicy): (s: string) => string {
  if (p === 'trim') return s => s.trim();
  if (p === 'whitespace') return s => s.replace(/[ \t\r\n]+/g, '');
  return s => s;
}

/** MergeConflictType.Type */
export type ChangeKind = 'inserted' | 'deleted' | 'modified' | 'conflict';

export type Side = 'left' | 'right';
export type ThreeSide = 'left' | 'base' | 'right';

/** A merge change (TextMergeChange + MergeLineFragment): line ranges [x0, x1) in the three revisions. */
export interface MergeChange {
  index: number;
  base: [number, number];
  left: [number, number];
  right: [number, number];
  kind: ChangeKind;
  /** MergeConflictType.isChange(LEFT / RIGHT) */
  leftChange: boolean;
  rightChange: boolean;
  /** Conflict with the TEXT resolution strategy: "Resolve Automatically" can merge it. */
  canResolve: boolean;
}

/** Per change state (TextMergeChange.State): result line range and resolved flags. */
export interface ChangeState {
  start: number;
  end: number;
  resolvedLeft: boolean;
  resolvedRight: boolean;
  /** One side of a conflict was applied; applying the other side appends ("isOnesideAppliedConflict"). */
  oneside: boolean;
}

// ---------------------------------------------------------------- text

/**
 * Splits text into lines like an IntelliJ document: a trailing newline gives a last empty line,
 * CR LF separators are normalized (and restored on write with `joinText`).
 */
export function splitText(text: string): { lines: string[]; crlf: boolean } {
  const crlf = /\r\n/.test(text);
  return { lines: text.replace(/\r\n?/g, '\n').split('\n'), crlf };
}

export function joinText(lines: string[], crlf: boolean): string {
  const text = lines.join('\n');
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

/** DiffUtil.getLinesContent: the lines of a range joined by newlines, without a trailing newline. */
export function linesContent(lines: string[], range: [number, number]): string {
  return lines.slice(range[0], range[1]).join('\n');
}

// ---------------------------------------------------------------- building changes

interface Unchanged {
  s1: number;
  e1: number;
  s2: number;
  e2: number;
}

function unchangedRanges(a: string[], b: string[]): Unchanged[] {
  const out: Unchanged[] = [];
  let p1 = 0;
  let p2 = 0;
  for (const c of buildChanges(a, b)) {
    if (c.line0 > p1) out.push({ s1: p1, e1: c.line0, s2: p2, e2: c.line1 });
    p1 = c.line0 + c.deleted;
    p2 = c.line1 + c.inserted;
  }
  if (p1 < a.length) out.push({ s1: p1, e1: a.length, s2: p2, e2: b.length });
  return out;
}

/**
 * ComparisonMergeUtil.buildSimple on lines: base ranges unchanged on both sides split the texts,
 * everything else forms merge fragments (touching changes of the two sides form one fragment).
 */
function mergeFragments(base: string[], left: string[], right: string[]): { base: [number, number]; left: [number, number]; right: [number, number] }[] {
  const u1 = unchangedRanges(base, left);
  const u2 = unchangedRanges(base, right);
  const out: { base: [number, number]; left: [number, number]; right: [number, number] }[] = [];
  let iL = 0;
  let iB = 0;
  let iR = 0;
  const add = (l: number, b: number, r: number) => {
    if (iL === l && iB === b && iR === r) return;
    out.push({ base: [iB, b], left: [iL, l], right: [iR, r] });
  };
  let a = 0;
  let c = 0;
  while (a < u1.length && c < u2.length) {
    const r1 = u1[a];
    const r2 = u2[c];
    if (r1.e1 <= r2.s1) {
      a++;
      continue;
    }
    if (r2.e1 <= r1.s1) {
      c++;
      continue;
    }
    const sb = Math.max(r1.s1, r2.s1);
    const eb = Math.min(r1.e1, r2.e1);
    const sl = r1.s2 + (sb - r1.s1);
    const sr = r2.s2 + (sb - r2.s1);
    add(sl, sb, sr);
    iL = sl + (eb - sb);
    iB = eb;
    iR = sr + (eb - sb);
    if (r1.e1 <= r2.e1) a++;
    else c++;
  }
  add(left.length, base.length, right.length);
  return out;
}

/** MergeRangeUtil.getLineMergeType */
function mergeType(
  f: { base: [number, number]; left: [number, number]; right: [number, number] },
  texts: { base: string[]; left: string[]; right: string[] },
  n: (s: string) => string,
): Omit<MergeChange, 'index' | 'base' | 'left' | 'right'> {
  const empty = (s: ThreeSide) => f[s][0] === f[s][1];
  const eq = (a: ThreeSide, b: ThreeSide, norm: (s: string) => string) => {
    const [a0, a1] = f[a];
    const [b0, b1] = f[b];
    if (a1 - a0 !== b1 - b0) return false;
    for (let i = 0; i < a1 - a0; i++) if (norm(texts[a][a0 + i]) !== norm(texts[b][b0 + i])) return false;
    return true;
  };
  const id = (s: string) => s;
  const leftEmpty = empty('left');
  const baseEmpty = empty('base');
  const rightEmpty = empty('right');
  const t = (kind: ChangeKind, leftChange: boolean, rightChange: boolean, canResolve = false) => ({ kind, leftChange, rightChange, canResolve });
  if (baseEmpty) {
    if (leftEmpty) return t('inserted', false, true);
    if (rightEmpty) return t('inserted', true, false);
    return eq('left', 'right', n) ? t('inserted', true, true) : t('conflict', true, true);
  }
  if (leftEmpty && rightEmpty) return t('deleted', true, true);
  const unchangedLeft = eq('base', 'left', n);
  const unchangedRight = eq('base', 'right', n);
  if (unchangedLeft && unchangedRight) return t('modified', !eq('base', 'left', id), !eq('base', 'right', id));
  if (unchangedLeft) return t(rightEmpty ? 'deleted' : 'modified', false, true);
  if (unchangedRight) return t(leftEmpty ? 'deleted' : 'modified', true, false);
  if (eq('left', 'right', n)) return t('modified', true, true);
  const canResolve = !leftEmpty && !rightEmpty && tryResolve(linesContent(texts.left, f.left), linesContent(texts.base, f.base), linesContent(texts.right, f.right)) !== undefined;
  return t('conflict', true, true, canResolve);
}

/** Builds the merge changes (ComparisonManager.mergeLines + getLineMergeType). */
export function buildMergeChanges(base: string[], left: string[], right: string[], ignore: IgnorePolicy = 'none'): MergeChange[] {
  const n = normalizer(ignore);
  const fragments = mergeFragments(base.map(n), left.map(n), right.map(n));
  const texts = { base, left, right };
  return fragments
    .map(f => ({ ...f, ...mergeType(f, texts, n) }))
    .filter(c => c.leftChange || c.rightChange)
    .map((c, index) => ({ ...c, index }));
}

export function initialStates(changes: MergeChange[]): ChangeState[] {
  return changes.map(c => ({ start: c.base[0], end: c.base[1], resolvedLeft: false, resolvedRight: false, oneside: false }));
}

export const isResolved = (s: ChangeState) => s.resolvedLeft && s.resolvedRight;
export const isSideResolved = (s: ChangeState, side: Side) => (side === 'left' ? s.resolvedLeft : s.resolvedRight);
export const isChange = (c: MergeChange, side: Side) => (side === 'left' ? c.leftChange : c.rightChange);

/** A line edit of the result: lines [start, end) replaced by `lines`, applied in order. */
export interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}

// ---------------------------------------------------------------- DiffUtil.updateRangeOnModification

export function updateRangeOnModification(start: number, end: number, changeStart: number, changeEnd: number, shift: number): { start: number; end: number; damaged: boolean } {
  if (end <= changeStart) return { start, end, damaged: false };
  if (start >= changeEnd) return { start: start + shift, end: end + shift, damaged: false };
  if (start <= changeStart && end >= changeEnd) return { start, end: end + shift, damaged: false };
  const newChangeEnd = changeEnd + shift;
  if (start >= changeStart && end <= changeEnd) return { start: newChangeEnd, end: newChangeEnd, damaged: true };
  if (start < changeStart) return { start, end: changeStart, damaged: true };
  return { start: newChangeEnd, end: end + shift, damaged: true };
}

// ---------------------------------------------------------------- the model

/**
 * MergeConflictModel over a line array. Operations change `lines` and `states` and record the
 * line edits in `edits`, so that an editor can replay them.
 */
export class MergeModel {
  edits: LineEdit[] = [];
  /** Set by merge commands (MergeConflictModel.contentModified). */
  contentModified = false;

  constructor(
    readonly changes: MergeChange[],
    readonly sides: { base: string[]; left: string[]; right: string[] },
    public lines: string[],
    public states: ChangeState[],
  ) {}

  static create(base: string[], left: string[], right: string[], ignore: IgnorePolicy = 'none'): MergeModel {
    const changes = buildMergeChanges(base, left, right, ignore);
    return new MergeModel(changes, { base, left, right }, base.slice(), initialStates(changes));
  }

  clone(): MergeModel {
    const m = new MergeModel(
      this.changes,
      this.sides,
      this.lines.slice(),
      this.states.map(s => ({ ...s })),
    );
    m.contentModified = this.contentModified;
    return m;
  }

  // ------------------------------------------------ queries

  get unresolved(): MergeChange[] {
    return this.changes.filter(c => !isResolved(this.states[c.index]));
  }

  stats(): { changes: number; conflicts: number } {
    let changes = 0;
    let conflicts = 0;
    for (const c of this.unresolved) {
      if (c.kind === 'conflict') conflicts++;
      else changes++;
    }
    return { changes, conflicts };
  }

  resolvedCount(): number {
    return this.changes.length - this.unresolved.length;
  }

  /** The result text of the change differs from the base (it was edited). */
  isChangeRangeModified(i: number): boolean {
    const c = this.changes[i];
    const s = this.states[i];
    return linesContent(this.sides.base, c.base) !== linesContent(this.lines, [s.start, s.end]) || c.base[1] - c.base[0] !== s.end - s.start;
  }

  /** MergeConflictModel.canResolveChangeAutomatically */
  canResolveAutomatically(i: number, side: ThreeSide): boolean {
    const c = this.changes[i];
    const s = this.states[i];
    if (c.kind === 'conflict') return side === 'base' && c.canResolve && !s.resolvedLeft && !s.resolvedRight && !this.isChangeRangeModified(i);
    const isChangeSide = side === 'base' ? true : isChange(c, side);
    return !isResolved(s) && isChangeSide && !this.isChangeRangeModified(i);
  }

  hasNonConflictedChanges(side: ThreeSide): boolean {
    return this.changes.some(c => c.kind !== 'conflict' && this.canResolveAutomatically(c.index, side));
  }

  hasAutoResolvableChanges(): boolean {
    return this.changes.some(c => this.canResolveAutomatically(c.index, 'base'));
  }

  // ------------------------------------------------ document edits

  /**
   * Replaces result lines [start, end) of change `index` and keeps the other change ranges in sync
   * (MergeModelBase.replaceChange / appendChange / moveChangesAfterInsertion).
   */
  private applyLines(index: number, start: number, end: number, newLines: string[], keepStart = start) {
    const shift = newLines.length - (end - start);
    this.lines.splice(start, end - start, ...newLines);
    if (this.lines.length === 0) this.lines.push('');
    this.edits.push({ start, end, lines: newLines });
    this.states.forEach((s, j) => {
      if (j === index) return;
      if (j < index) {
        // Changes before stay before the edit.
        s.start = Math.min(s.start, start);
        s.end = Math.min(s.end, start);
      } else if (s.start >= end) {
        s.start += shift;
        s.end += shift;
      } else {
        s.start = Math.max(s.start + shift, start + newLines.length);
        s.end = Math.max(s.end + shift, s.start);
      }
    });
    const st = this.states[index];
    st.start = keepStart;
    st.end = end + shift;
  }

  /** MergeModelBase.replaceChange */
  private replaceContent(i: number, newLines: string[]) {
    const s = this.states[i];
    this.applyLines(i, s.start, s.end, newLines);
  }

  /** MergeModelBase.appendChange */
  private appendContent(i: number, newLines: string[]) {
    const s = this.states[i];
    this.applyLines(i, s.end, s.end, newLines, s.start);
  }

  /**
   * Updates the change ranges after an edit of the result made by the user (MergeModelBase.DocumentListener):
   * `line1`..`line2` is the affected line range of the old document, `shift` the change of the line count.
   */
  onUserEdit(line1: number, line2: number, shift: number) {
    this.states.forEach((s, i) => {
      const r = updateRangeOnModification(s.start, s.end, line1, line2, shift);
      s.start = r.start;
      s.end = r.end;
      const c = this.changes[i];
      // MergeConflictModel.MergeModelImpl.processDocumentChange
      if (s.start === s.end && c.kind === 'deleted' && !isResolved(s)) {
        s.resolvedLeft = true;
        s.resolvedRight = true;
      }
    });
  }

  // ------------------------------------------------ resolving

  markResolved(i: number) {
    const s = this.states[i];
    s.resolvedLeft = true;
    s.resolvedRight = true;
  }

  private markSideResolved(i: number, side: Side) {
    const s = this.states[i];
    if (isResolved(s)) return;
    if (side === 'left') s.resolvedLeft = true;
    else s.resolvedRight = true;
  }

  /** MergeConflictModel.ignoreChange */
  ignoreChange(i: number, side: Side, resolveChange: boolean) {
    const c = this.changes[i];
    this.contentModified = true;
    if (c.kind !== 'conflict' || resolveChange) this.markResolved(i);
    else this.markSideResolved(i, side);
  }

  /** MergeConflictModel.replaceChange: applies a side; returns false when nothing was done. */
  replaceChange(i: number, side: Side, resolveChange: boolean): boolean {
    const c = this.changes[i];
    const s = this.states[i];
    if (isSideResolved(s, side)) return false;
    this.contentModified = true;
    if (!isChange(c, side)) {
      this.markResolved(i);
      return false;
    }
    const content = this.sides[side].slice(c[side][0], c[side][1]);
    if (c.kind === 'conflict') {
      if (s.oneside) this.appendContent(i, content);
      else this.replaceContent(i, content);
      const opposite: Side = side === 'left' ? 'right' : 'left';
      if (resolveChange || c[opposite][0] === c[opposite][1]) this.markResolved(i);
      else {
        this.states[i].oneside = true;
        this.markSideResolved(i, side);
      }
    } else {
      this.replaceContent(i, content);
      this.markResolved(i);
    }
    return true;
  }

  /** MergeConflictModel.resolveChangeAutomatically */
  resolveChangeAutomatically(i: number, side: ThreeSide): boolean {
    if (!this.canResolveAutomatically(i, side)) return false;
    const c = this.changes[i];
    const s = this.states[i];
    if (c.kind === 'conflict') {
      const resolved = tryResolve(linesContent(this.sides.left, c.left), linesContent(this.lines, [s.start, s.end]), linesContent(this.sides.right, c.right));
      if (resolved === undefined) return false;
      this.contentModified = true;
      this.replaceContent(i, resolved.split('\n'));
      this.markResolved(i);
      return true;
    }
    const master: Side = side === 'left' ? 'left' : side === 'right' ? 'right' : c.leftChange ? 'left' : 'right';
    return this.replaceChange(i, master, false);
  }

  /** MergeThreesideViewer.applyNonConflictedChanges */
  applyNonConflictedChanges(side: ThreeSide) {
    for (const c of this.changes) if (c.kind !== 'conflict') this.resolveChangeAutomatically(c.index, side);
  }

  /** MergeConflictModel.resolveAllChangesAutomatically / MergeThreesideViewer.applyResolvableConflictedChanges */
  resolveAllChangesAutomatically(): boolean {
    let any = false;
    for (const c of this.changes) if (this.resolveChangeAutomatically(c.index, 'base')) any = true;
    return any;
  }

  /** MergeConflictModel.resetResolvedChange */
  resetResolvedChange(i: number, force = false) {
    const s = this.states[i];
    if (!force && !isResolved(s)) return;
    const c = this.changes[i];
    this.replaceContent(i, this.sides.base.slice(c.base[0], c.base[1]));
    const st = this.states[i];
    st.resolvedLeft = st.resolvedRight = st.oneside = false;
  }

  /** MergeConflictModel.resetAllChanges: back to the base text with every change unresolved. */
  resetAllChanges() {
    this.contentModified = true;
    this.edits.push({ start: 0, end: this.lines.length, lines: this.sides.base.slice() });
    this.lines = this.sides.base.slice();
    this.states = initialStates(this.changes);
  }

  /** MergeConflictModel.acceptRevisionForSide ("Accept Left" / "Accept Right") */
  acceptRevisionForSide(side: Side) {
    this.resetAllChanges();
    for (const c of this.changes) this.replaceChange(c.index, side, true);
  }

  markAllChangesResolved() {
    this.contentModified = true;
    for (const c of this.changes) this.markResolved(c.index);
  }

  takeEdits(): LineEdit[] {
    const e = this.edits;
    this.edits = [];
    return e;
  }
}

// ---------------------------------------------------------------- texts (DiffBundle)

/** merge.differences.status.text: "2 changes, 1 conflict" / "No changes, No conflicts". */
export function statusText(s: { changes: number; conflicts: number }): string {
  const ch = s.changes === 0 ? 'No changes' : s.changes === 1 ? '1 change' : `${s.changes} changes`;
  const co = s.conflicts === 0 ? 'No conflicts' : s.conflicts === 1 ? '1 conflict' : `${s.conflicts} conflicts`;
  return `${ch}, ${co}`;
}

/** merge.dialog.apply.partially.resolved.changes.confirmation.message */
export function unprocessedMessage(s: { changes: number; conflicts: number }): string {
  const { changes, conflicts } = s;
  const verb = changes === 0 ? (conflicts === 1 ? 'is' : 'are') : changes === 1 ? 'is' : 'are';
  const ch = changes === 0 ? '' : changes === 1 ? 'one change' : `${changes} changes`;
  const and = changes === 0 ? '' : conflicts === 0 ? '' : ' and ';
  const co = conflicts === 0 ? '' : conflicts === 1 ? 'one conflict' : `${conflicts} conflicts`;
  return `There ${verb} ${ch}${and}${co} left unprocessed.\nSave changes and mark the conflict resolved anyway?`;
}

/** iterative.merge.dialog.apply.partially.resolved.changes.confirmation.message */
export function iterativeUnprocessedMessage(conflicts: number, changes: number): string {
  const co = conflicts === 0 ? '' : conflicts === 1 ? '1 unresolved conflict' : `${conflicts} unresolved conflicts`;
  const and = conflicts === 0 ? '' : changes === 0 ? '' : ' and ';
  const ch = changes === 0 ? '' : changes === 1 ? '1 unprocessed change' : `${changes} unprocessed changes`;
  const verb = conflicts === 0 ? (changes <= 1 ? 'remains' : 'remain') : changes === 0 ? 'remains' : 'remain';
  return `${co}${and}${ch} still ${verb}. The file will be saved exactly as shown in the Result pane.`;
}
