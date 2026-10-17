import { history, historyKeymap, defaultKeymap, undo, redo } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Extension, Text } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { buildMergeChunks, MergeChunk, sideKind, toLines } from '../../shared/mergeModel';
import { MergeInit, MergeSettings } from '../../shared/mergeProtocol';
import { iconUrl } from '../lib/icons';
import {
  applyMany,
  applySide,
  buildDecorations,
  chunkField,
  ChunkState,
  createResultState,
  decorationField,
  ignoreSide,
  isResolved,
  lineRange,
  linesText,
  Region,
  resetAll,
  resolveChunk,
  setDecorations,
  sideActive,
  Sides,
  stats,
  wordDiff,
} from './engine';
import { editorTheme, syntaxTheme } from './theme';

type Pane = 'left' | 'result' | 'right';

/**
 * Imperative part of the merge window: three CodeMirror editors, the divider strips with IntelliJ's
 * curved connectors, the apply / ignore controls, synchronized scrolling and navigation.
 */
export class MergeController {
  chunks: MergeChunk[] = [];
  sides: Sides;
  views!: Record<Pane, EditorView>;
  private readonly syntax = new Compartment();
  private readonly lang = new Compartment();
  private syncing = false;
  private frame = 0;
  private readonly listeners = new Set<() => void>();
  /** Result text when the merge started, to know whether it was modified. */
  private initialResult = '';
  private trailingNewline: boolean;

  constructor(
    readonly init: MergeInit,
    public settings: MergeSettings,
    private dark: boolean,
  ) {
    const b = toLines(init.base);
    const l = toLines(init.left);
    const r = toLines(init.right);
    this.trailingNewline = l.trailingNewline || r.trailingNewline;
    this.sides = { base: b.lines, left: l.lines, right: r.lines };
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach(f => f());
  }

  mount(hosts: Record<Pane, HTMLElement>, controls: Record<Pane, HTMLElement>, dividers: [SVGSVGElement, SVGSVGElement]) {
    this.hosts = hosts;
    this.controls = controls;
    this.dividers = dividers;
    const common = (editable: boolean): Extension[] => [
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      editorTheme,
      this.syntax.of(syntaxTheme(this.dark)),
      this.lang.of([]),
      decorationField,
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
      EditorView.updateListener.of(u => {
        if (u.geometryChanged || u.viewportChanged) this.schedule();
      }),
    ];
    this.chunks = buildMergeChunks(this.sides.base, this.sides.left, this.sides.right, this.settings.ignore);
    const resultText = linesText(this.sides.base, [0, this.sides.base.length]);
    this.views = {
      left: new EditorView({ parent: hosts.left, state: EditorState.create({ doc: linesText(this.sides.left, [0, this.sides.left.length]), extensions: common(false) }) }),
      right: new EditorView({ parent: hosts.right, state: EditorState.create({ doc: linesText(this.sides.right, [0, this.sides.right.length]), extensions: common(false) }) }),
      result: new EditorView({
        parent: hosts.result,
        state: createResultState(resultText, this.chunks, [
          ...common(true),
          history(),
          highlightActiveLine(),
          keymap.of([...this.mergeKeymap(), ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of(u => {
            if (u.docChanged || u.transactions.some(t => t.effects.some(e => !e.is(setDecorations)))) {
              this.refreshDecorations();
              this.emit();
            }
          }),
        ]),
      }),
    };
    this.initialResult = resultText;
    for (const p of ['left', 'result', 'right'] as Pane[]) {
      this.views[p].scrollDOM.addEventListener('scroll', () => this.onScroll(p));
    }
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(hosts.result.parentElement!.parentElement!);
    }
    if (this.settings.autoApply) this.applyNonConflicting('all');
    this.refreshDecorations();
    void this.loadLanguage();
    this.emit();
    requestAnimationFrame(() => this.goTo(this.firstUnresolved(), false));
  }

  private hosts!: Record<Pane, HTMLElement>;
  private resizeObserver: ResizeObserver | undefined;
  private controls!: Record<Pane, HTMLElement>;
  private dividers!: [SVGSVGElement, SVGSVGElement];

  private async loadLanguage() {
    const desc = LanguageDescription.matchFilename(languages, this.init.fileName);
    if (!desc) return;
    try {
      const support = await desc.load();
      for (const v of Object.values(this.views)) v.dispatch({ effects: this.lang.reconfigure(support) });
    } catch {
      // Plain text.
    }
  }

  setDark(dark: boolean) {
    this.dark = dark;
    for (const v of Object.values(this.views)) v.dispatch({ effects: this.syntax.reconfigure(syntaxTheme(dark)) });
  }

  get states(): ChunkState[] {
    return this.views.result.state.field(chunkField);
  }

  get stats() {
    return stats(this.chunks, this.states);
  }

  get modified() {
    return this.views.result.state.doc.toString() !== this.initialResult;
  }

  resultText(): string {
    const text = this.views.result.state.doc.toString();
    return this.trailingNewline || !text.endsWith('\n') ? text : text.slice(0, -1);
  }

  // ---------------------------------------------------------------- actions

  apply(i: number, side: 'left' | 'right') {
    applySide(this.views.result, this.chunks, this.sides, i, side);
  }

  ignore(i: number, side: 'left' | 'right') {
    ignoreSide(this.views.result, this.chunks, i, side);
  }

  magic(i: number) {
    resolveChunk(this.views.result, this.chunks, i);
  }

  hasNonConflicting(side: 'left' | 'right' | 'all') {
    return this.nonConflicting(side).length > 0;
  }

  private nonConflicting(side: 'left' | 'right' | 'all') {
    const states = this.states;
    const out: { i: number; side: 'left' | 'right' }[] = [];
    this.chunks.forEach((c, i) => {
      if (c.type === 'conflict' || isResolved(c, states[i])) return;
      if (side === 'all' || c.type === side || c.type === 'both') out.push({ i, side: c.type === 'right' ? 'right' : c.type === 'left' ? 'left' : side === 'right' ? 'right' : 'left' });
    });
    return out;
  }

  applyNonConflicting(side: 'left' | 'right' | 'all') {
    applyMany(this.views.result, this.chunks, this.sides, this.nonConflicting(side));
  }

  hasResolvable() {
    const states = this.states;
    return this.chunks.some((c, i) => c.type === 'conflict' && c.resolved && !states[i].l && !states[i].r);
  }

  resolveSimpleConflicts() {
    const states = this.states;
    const picks = this.chunks.flatMap((c, i) => (c.type === 'conflict' && c.resolved && !states[i].l && !states[i].r ? [{ i, side: 'magic' as const }] : []));
    applyMany(this.views.result, this.chunks, this.sides, picks);
  }

  revertAll() {
    resetAll(this.views.result, this.chunks, this.initialResult);
  }

  undo() {
    undo(this.views.result);
  }

  redo() {
    redo(this.views.result);
  }

  /** Recomputes the chunks with new settings (ignore policy) and starts the merge over. */
  restart(settings: MergeSettings) {
    this.settings = settings;
    for (const v of Object.values(this.views)) v.destroy();
    this.mount(this.hosts, this.controls, this.dividers);
  }

  // ---------------------------------------------------------------- navigation

  private firstUnresolved(): number {
    const states = this.states;
    return this.chunks.findIndex((c, i) => !isResolved(c, states[i]));
  }

  /** Index of the chunk at / after the caret of the result editor. */
  private caretChunk(): number {
    const pos = this.views.result.state.selection.main.head;
    const states = this.states;
    let best = -1;
    states.forEach((s, i) => {
      if (pos >= s.from && pos <= Math.max(s.to, s.from)) best = i;
    });
    return best;
  }

  navigate(dir: 1 | -1) {
    const states = this.states;
    const pos = this.views.result.state.selection.main.head;
    const open = this.chunks.map((c, i) => i).filter(i => !isResolved(this.chunks[i], states[i]));
    if (!open.length) return;
    let target: number | undefined;
    if (dir > 0) target = open.find(i => states[i].from > pos) ?? open[0];
    else target = [...open].reverse().find(i => states[i].to < pos || (states[i].from < pos && states[i].to <= pos)) ?? open[open.length - 1];
    this.goTo(target, true);
  }

  canNavigate(dir: 1 | -1) {
    return this.stats.changes + this.stats.conflicts > 0 && !!dir;
  }

  goTo(i: number, focus: boolean) {
    if (i < 0 || !this.views) return;
    const st = this.states[i];
    const v = this.views.result;
    v.dispatch({ selection: { anchor: st.from }, effects: EditorView.scrollIntoView(st.from, { y: 'center' }) });
    if (focus) v.focus();
    requestAnimationFrame(() => this.syncFrom('result'));
  }

  private mergeKeymap() {
    const at = (fn: (i: number) => void) => () => {
      const i = this.caretChunk();
      if (i >= 0) fn(i);
      return true;
    };
    return [
      { key: 'F7', run: () => (this.navigate(1), true) },
      { key: 'Shift-F7', run: () => (this.navigate(-1), true) },
      { key: 'Ctrl-Alt-ArrowDown', run: () => (this.navigate(1), true) },
      { key: 'Ctrl-Alt-ArrowUp', run: () => (this.navigate(-1), true) },
      // Diff.ApplyLeftSide / Diff.ApplyRightSide
      { key: 'Ctrl-Alt-r', run: at(i => this.apply(i, 'left')) },
      { key: 'Ctrl-Alt-a', run: at(i => this.apply(i, 'right')) },
    ];
  }

  // ---------------------------------------------------------------- decorations

  private refreshDecorations() {
    const states = this.states;
    const left: Region[] = [];
    const right: Region[] = [];
    const result: Region[] = [];
    const resultDoc = this.views.result.state.doc;
    const word = this.settings.highlight === 'words';
    this.chunks.forEach((c, i) => {
      const st = states[i];
      if (isResolved(c, st)) return;
      const baseText = linesText(this.sides.base, c.base).replace(/\n$/, '');
      for (const side of ['left', 'right'] as const) {
        const kind = sideKind(c, side);
        if (kind === 'none' || !sideActive(c, st, side)) continue;
        const text = linesText(this.sides[side], c[side]).replace(/\n$/, '');
        const region: Region = { l0: c[side][0], l1: c[side][1], kind };
        if (word && (kind === 'modified' || kind === 'conflict') && c.base[1] > c.base[0]) region.inner = wordDiff(baseText, text).b;
        (side === 'left' ? left : right).push(region);
      }
      const [r0, r1] = lineRange(resultDoc, st.from, st.to);
      const kind = c.type === 'conflict' ? 'conflict' : sideKind(c, c.type === 'right' ? 'right' : 'left');
      const region: Region = { l0: r0, l1: r1, kind };
      if (word && !st.l && !st.r && (kind === 'modified' || kind === 'conflict') && r1 > r0) {
        // Unchanged result shows the base text: highlight what the sides changed in it.
        const ranges: [number, number][] = [];
        for (const side of ['left', 'right'] as const) {
          if (sideKind(c, side) === 'none') continue;
          ranges.push(...wordDiff(baseText, linesText(this.sides[side], c[side]).replace(/\n$/, '')).a);
        }
        region.inner = ranges;
      }
      result.push(region);
    });
    const h = this.settings.highlight;
    this.views.left.dispatch({ effects: setDecorations.of(buildDecorations(this.views.left.state.doc, left, h)) });
    this.views.right.dispatch({ effects: setDecorations.of(buildDecorations(this.views.right.state.doc, right, h)) });
    this.views.result.dispatch({ effects: setDecorations.of(buildDecorations(resultDoc, result, h)) });
    this.schedule();
  }

  setHighlight(h: MergeSettings['highlight']) {
    this.settings = { ...this.settings, highlight: h };
    this.refreshDecorations();
  }

  // ---------------------------------------------------------------- scrolling

  private onScroll(p: Pane) {
    if (!this.syncing && this.settings.syncScroll) this.syncFrom(p);
    this.schedule();
  }

  /** Line correspondences between a side and the result: [sideLine, resultLine] anchors in order. */
  private anchors(side: 'left' | 'right'): [number, number][] {
    const out: [number, number][] = [[0, 0]];
    const doc = this.views.result.state.doc;
    const states = this.states;
    this.chunks.forEach((c, i) => {
      const [r0, r1] = lineRange(doc, states[i].from, states[i].to);
      out.push([c[side][0], r0], [c[side][1], r1]);
    });
    out.push([this.views[side].state.doc.lines, doc.lines]);
    return out;
  }

  private mapLine(line: number, from: Pane, to: Pane): number {
    if (from === to) return line;
    if (from !== 'result' && to !== 'result') return this.mapLine(this.mapLine(line, from, 'result'), 'result', to);
    const side = (from === 'result' ? to : from) as 'left' | 'right';
    const pairs = this.anchors(side).map(([s, r]) => (from === 'result' ? [r, s] : [s, r]));
    for (let k = 1; k < pairs.length; k++) {
      const [a0, b0] = pairs[k - 1];
      const [a1, b1] = pairs[k];
      if (line <= a1) {
        if (a1 === a0) return b1;
        return b0 + ((line - a0) * (b1 - b0)) / (a1 - a0);
      }
    }
    const last = pairs[pairs.length - 1];
    return last[1] + (line - last[0]);
  }

  /** IntelliJ's SyncScrollSupport: keeps the middle line of every pane on the same change. */
  syncFrom(master: Pane) {
    if (!this.views) return;
    const m = this.views[master];
    const mid = m.scrollDOM.scrollTop + m.scrollDOM.clientHeight / 2;
    const block = m.lineBlockAtHeight(mid);
    const line = m.state.doc.lineAt(block.from).number - 1 + (mid - block.top) / Math.max(1, block.height);
    this.syncing = true;
    for (const p of ['left', 'result', 'right'] as Pane[]) {
      if (p === master) continue;
      const v = this.views[p];
      const target = this.mapLine(line, master, p);
      const n = Math.max(0, Math.min(v.state.doc.lines - 1, Math.floor(target)));
      const b = v.lineBlockAt(v.state.doc.line(n + 1).from);
      const y = b.top + (target - n) * b.height;
      v.scrollDOM.scrollTop = y - v.scrollDOM.clientHeight / 2;
    }
    requestAnimationFrame(() => (this.syncing = false));
  }

  // ---------------------------------------------------------------- dividers and controls

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** y of the top of 0-based line `n` in pane coordinates (n may be the line count: bottom of the text). */
  private lineY(p: Pane, n: number): number {
    const v = this.views[p];
    const doc = v.state.doc;
    const offset = v.documentTop - this.hosts[p].getBoundingClientRect().top;
    if (n >= doc.lines) {
      const last = v.lineBlockAt(doc.line(doc.lines).from);
      return (doc.line(doc.lines).length === 0 && n === doc.lines - 1 ? last.top : last.bottom) + offset;
    }
    return v.lineBlockAt(doc.line(n + 1).from).top + offset;
  }

  private paint() {
    if (!this.views) return;
    const states = this.states;
    const resultDoc = this.views.result.state.doc;
    const parts: { left: string[]; right: string[] } = { left: [], right: [] };
    const ctrl: Record<Pane, string[]> = { left: [], result: [], right: [] };
    const h = this.hosts.result.clientHeight;
    const visible = (y0: number, y1: number) => y1 >= -20 && y0 <= h + 20;
    this.chunks.forEach((c, i) => {
      const st = states[i];
      if (isResolved(c, st)) return;
      const [r0, r1] = lineRange(resultDoc, st.from, st.to);
      const ry0 = this.lineY('result', r0);
      const ry1 = r1 === r0 ? ry0 : this.lineY('result', r1);
      for (const side of ['left', 'right'] as const) {
        const kind = sideKind(c, side);
        if (kind === 'none' || !sideActive(c, st, side)) continue;
        const sy0 = this.lineY(side, c[side][0]);
        const sy1 = c[side][1] === c[side][0] ? sy0 : this.lineY(side, c[side][1]);
        if (!visible(Math.min(sy0, ry0), Math.max(sy1, ry1))) continue;
        parts[side].push(connector(side, sy0, sy1, ry0, ry1, kind));
        // Controls: ">>" / "<<" (or append when the other side of a conflict is in the result) and "×".
        const append = c.type === 'conflict' && st.applied && st.applied !== side;
        const arrow = side === 'left' ? (append ? 'diff/arrowRightDown@14x14' : 'diff/arrowRight@14x14') : append ? 'diff/arrowLeftDown@14x14' : 'diff/arrow@14x14';
        const applyTip = append ? (side === 'left' ? 'Append Left Side' : 'Append Right Side') : side === 'left' ? 'Accept Left Side' : 'Accept Right Side';
        const ignoreTip = side === 'left' ? 'Ignore Left Side' : 'Ignore Right Side';
        const y = Math.round(sy0 + 2);
        const applyBtn = button(i, side, 'apply', arrow, applyTip, this.dark);
        const ignoreBtn = button(i, side, 'ignore', 'diff/remove@14x14', ignoreTip, this.dark);
        ctrl[side].push(`<div class="mg-ctrl-row" style="top:${y}px">${side === 'left' ? ignoreBtn + applyBtn : applyBtn + ignoreBtn}</div>`);
      }
      if (c.type === 'conflict' && c.resolved && !st.l && !st.r && visible(ry0, ry1)) {
        ctrl.result.push(`<div class="mg-ctrl-row" style="top:${Math.round(ry0 + 2)}px">${button(i, 'result', 'magic', 'diff/magicResolve@14x14', 'Resolve Automatically', this.dark)}</div>`);
      }
    });
    for (const [k, side] of [
      [0, 'left'],
      [1, 'right'],
    ] as const) {
      const svg = this.dividers[k];
      svg.innerHTML = parts[side].join('');
    }
    for (const p of ['left', 'result', 'right'] as Pane[]) this.controls[p].innerHTML = ctrl[p].join('');
  }
}

const W = 30;

/** IntelliJ's curved divider polygon between a side range and the result range. */
function connector(side: 'left' | 'right', sy0: number, sy1: number, ry0: number, ry1: number, kind: string): string {
  // Left divider: side on x=0, result on x=W. Right divider: result on x=0, side on x=W.
  const [x0, y00, y01, x1, y10, y11] = side === 'left' ? [0, sy0, sy1, W, ry0, ry1] : [0, ry0, ry1, W, sy0, sy1];
  const mx = (x0 + x1) / 2;
  const top = `M${x0},${y00} C${mx},${y00} ${mx},${y10} ${x1},${y10}`;
  const empty = y00 === y01 && y10 === y11;
  if (empty) return `<path class="mg-conn-line mg-${kind}" d="${top}"/>`;
  const d = `${top} L${x1},${y11} C${mx},${y11} ${mx},${y01} ${x0},${y01} Z`;
  return `<path class="mg-conn mg-${kind}" d="${d}"/>`;
}

function button(i: number, side: string, action: string, icon: string, tip: string, dark: boolean) {
  return `<button class="mg-ctrl-btn" data-i="${i}" data-side="${side}" data-action="${action}" data-tip="${tip}"><img src="${iconUrl(icon, dark)}" width="14" height="14" draggable="false"></button>`;
}

export type { Text };
