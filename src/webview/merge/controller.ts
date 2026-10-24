import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Extension, RangeSetBuilder, Text } from '@codemirror/state';
import { drawSelection, EditorView, gutter, gutterLineClass, GutterMarker, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { ChangeState, isChange, isResolved, isSideResolved, linesContent, MergeChange, MergeModel, Side, splitText } from '../../shared/mergeModel';
import { MergeInit, MergeSettings } from '../../shared/mergeProtocol';
import { innerDifferences } from '../../shared/mergeResolve';
import { iconUrl } from '../lib/icons';
import { t } from '../lib/l10n';
import { MenuEntry } from '../lib/menu';
import {
  buildDecorations,
  buildFolds,
  decorationField,
  Fold,
  foldField,
  gutterClasses,
  gutterClassField,
  modelExtension,
  modelOf,
  modelValue,
  Operation,
  OperationsMarker,
  operationsField,
  Region,
  runCommand,
  setDecorations,
  setFolds,
  setGutterClasses,
  setOperations,
} from './engine';
import { editorTheme, syntaxTheme } from './theme';

export type Pane = 'left' | 'result' | 'right';

const ICONS = {
  applyLeft: 'diff/arrowRight@14x14',
  appendLeft: 'diff/arrowRightDown@14x14',
  applyRight: 'diff/arrow@14x14',
  appendRight: 'diff/arrowLeftDown@14x14',
  ignore: 'diff/remove@14x14',
  resolve: 'diff/magicResolve@14x14',
};

/**
 * Imperative part of the merge window (MergeThreesideViewer): three CodeMirror editors, the dividers with
 * IntelliJ's curved connectors, gutter operations, folding of unchanged fragments, synchronized scrolling,
 * navigation and the editor context menus.
 */
export class MergeController {
  changes: MergeChange[] = [];
  readonly sides: MergeModel['sides'];
  views!: Record<Pane, EditorView>;
  private readonly syntax = new Compartment();
  private readonly lang = new Compartment();
  private syncing = false;
  private frame = 0;
  private readonly listeners = new Set<() => void>();
  /** Folding groups the user expanded. */
  private expandedGroups = new Set<number>();
  private hosts!: Record<Pane, HTMLElement>;
  private dividers!: [SVGSVGElement, SVGSVGElement];
  private resizeObserver: ResizeObserver | undefined;
  /** Ctrl (Cmd) is held: gutter operations resolve the whole conflict (ModifierProvider). */
  ctrlPressed = false;
  readonly crlf: boolean;

  constructor(
    readonly init: MergeInit,
    public settings: MergeSettings,
    private dark: boolean,
  ) {
    const b = splitText(init.base);
    const l = splitText(init.left);
    const r = splitText(init.right);
    this.crlf = l.crlf || r.crlf || b.crlf;
    this.sides = { base: b.lines, left: l.lines, right: r.lines };
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach(f => f());
  }

  mount(hosts: Record<Pane, HTMLElement>, dividers: [SVGSVGElement, SVGSVGElement], progress = this.init.progress) {
    this.hosts = hosts;
    this.dividers = dividers;
    const base = MergeModel.create(this.sides.base, this.sides.left, this.sides.right, this.settings.ignore);
    this.changes = base.changes;
    const startLines = progress ? progress.lines : base.lines;
    const startStates = progress && progress.states.length === base.states.length ? progress.states : base.states;
    const common = (pane: Pane, editable: boolean): Extension[] => [
      lineNumbers(),
      gutter({
        class: 'mg-ops-gutter',
        markers: v => v.state.field(operationsField),
        initialSpacer: () => new SpacerMarker(pane === 'result' ? 1 : 2),
      }),
      gutterLineClass.from(gutterClassField),
      highlightActiveLineGutter(),
      drawSelection(),
      highlightActiveLine(),
      editorTheme,
      this.syntax.of(syntaxTheme(this.dark)),
      this.lang.of([]),
      decorationField,
      gutterClassField,
      operationsField,
      foldField,
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
      EditorView.updateListener.of(u => {
        if (u.geometryChanged || u.viewportChanged) this.schedule();
      }),
      keymap.of(this.mergeKeymap(pane)),
    ];
    const doc = (lines: string[]) => Text.of(lines);
    this.views = {
      left: new EditorView({ parent: hosts.left, state: EditorState.create({ doc: doc(this.sides.left), extensions: common('left', false) }) }),
      right: new EditorView({ parent: hosts.right, state: EditorState.create({ doc: doc(this.sides.right), extensions: common('right', false) }) }),
      result: new EditorView({
        parent: hosts.result,
        state: EditorState.create({
          doc: doc(startLines),
          extensions: [
            modelExtension(this.changes, { states: startStates, contentModified: progress?.contentModified ?? false }, this.sides),
            ...common('result', true),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of(u => {
              if (u.docChanged || u.transactions.some(tr => tr.effects.length && !tr.effects.every(e => e.is(setDecorations) || e.is(setFolds) || e.is(setOperations) || e.is(setGutterClasses)))) {
                this.refresh();
                this.emit();
              }
            }),
          ],
        }),
      }),
    };
    for (const p of ['left', 'result', 'right'] as Pane[]) {
      this.views[p].scrollDOM.addEventListener('scroll', () => this.onScroll(p));
    }
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(hosts.result.parentElement!.parentElement!);
    }
    if (this.settings.autoApply && !progress) this.applyNonConflicting('base', false);
    this.refresh();
    void this.loadLanguage();
    this.emit();
    requestAnimationFrame(() => {
      // The left editor scrolls in a right-to-left container (its gutter is next to the divider): show the text start.
      const l = this.views.left.scrollDOM;
      l.scrollLeft = -(l.scrollWidth - l.clientWidth);
      this.goTo(this.firstUnresolved(), false);
    });
  }

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
    this.refresh();
  }

  get states(): ChangeState[] {
    return modelValue(this.views.result.state).states;
  }

  get model(): MergeModel {
    return modelOf(this.views.result, this.changes, this.sides);
  }

  get stats() {
    return this.model.stats();
  }

  get contentModified() {
    return modelValue(this.views.result.state).contentModified;
  }

  resultLines(): string[] {
    return this.views.result.state.doc.toString().split('\n');
  }

  // ---------------------------------------------------------------- merge commands

  private command(fn: (m: MergeModel) => void) {
    return runCommand(this.views.result, this.changes, this.sides, fn);
  }

  /** Gutter "Accept" (replaceSingleChange); `resolve` = Ctrl+click. */
  apply(i: number, side: Side, resolve = false) {
    this.command(m => m.replaceChange(i, side, resolve));
  }

  /** Gutter "Ignore" */
  ignore(i: number, side: Side, resolve = false) {
    this.command(m => m.ignoreChange(i, side, resolve));
  }

  /** Gutter "Resolve" (magic wand) */
  resolve(i: number) {
    this.command(m => m.resolveChangeAutomatically(i, 'base'));
  }

  hasNonConflicting(side: 'left' | 'base' | 'right') {
    return this.model.hasNonConflictedChanges(side);
  }

  /** Apply Non-Conflicting Changes (Left / All / Right). */
  applyNonConflicting(side: 'left' | 'base' | 'right', scroll = true) {
    this.command(m => m.applyNonConflictedChanges(side));
    if (scroll) this.goTo(this.firstUnresolved(), true);
  }

  hasResolvable() {
    return this.model.hasAutoResolvableChanges();
  }

  /** Resolve Simple Conflicts (applyResolvableConflictedChanges) */
  resolveSimpleConflicts() {
    this.command(m => m.resolveAllChangesAutomatically());
    this.goTo(this.firstUnresolved(), true);
  }

  /** Revert Conflict Resolution */
  revertAll() {
    this.command(m => m.resetAllChanges());
  }

  acceptSide(side: Side) {
    this.command(m => m.acceptRevisionForSide(side));
  }

  markAllResolved() {
    this.command(m => m.markAllChangesResolved());
  }

  undo() {
    undo(this.views.result);
  }

  redo() {
    redo(this.views.result);
  }

  /** Recomputes the changes with new settings (ignore policy) and starts the merge over. */
  restart(settings: MergeSettings) {
    this.settings = settings;
    for (const v of Object.values(this.views)) v.destroy();
    this.expandedGroups.clear();
    this.mount(this.hosts, this.dividers, undefined);
  }

  // ---------------------------------------------------------------- selected changes (ApplySelectedChangesActionBase)

  private selectedLines(pane: Pane): Set<number> {
    const v = this.views[pane];
    const out = new Set<number>();
    for (const r of v.state.selection.ranges) {
      const l0 = v.state.doc.lineAt(r.from).number - 1;
      let l1 = v.state.doc.lineAt(r.to).number - 1;
      if (!r.empty && l1 > l0 && v.state.doc.line(l1 + 1).from === r.to) l1--;
      for (let l = l0; l <= l1; l++) out.add(l);
    }
    return out;
  }

  private range(i: number, pane: Pane): [number, number] {
    if (pane === 'result') {
      const s = this.states[i];
      return [s.start, s.end];
    }
    return this.changes[i][pane];
  }

  /** DiffUtil.isSelectedByLine */
  private selectedChanges(pane: Pane, enabled: (c: MergeChange, s: ChangeState) => boolean): number[] {
    const lines = this.selectedLines(pane);
    const states = this.states;
    return this.changes
      .filter(c => enabled(c, states[c.index]))
      .filter(c => {
        const [l1, l2] = this.range(c.index, pane);
        if (l1 === l2) return lines.has(l1);
        for (let l = l1; l < l2; l++) if (lines.has(l)) return true;
        return false;
      })
      .map(c => c.index);
  }

  /** Accept (Diff.ApplyLeftSide / Diff.ApplyRightSide) and "Resolve using Left / Right" on the selected changes. */
  applySelected(pane: Pane, side: Side, resolve: boolean) {
    const ids = this.selectedChanges(pane, (_c, s) => !isSideResolved(s, side));
    if (ids.length) this.command(m => ids.forEach(i => m.replaceChange(i, side, resolve)));
  }

  ignoreSelectedSide(pane: Pane, side: Side) {
    const ids = this.selectedChanges(pane, (_c, s) => !isSideResolved(s, side));
    if (ids.length) this.command(m => ids.forEach(i => m.ignoreChange(i, side, false)));
  }

  ignoreSelected() {
    const ids = this.selectedChanges('result', (_c, s) => !isResolved(s));
    if (ids.length) this.command(m => ids.forEach(i => m.markResolved(i)));
  }

  resolveSelected() {
    const model = this.model;
    const ids = this.selectedChanges('result', c => model.canResolveAutomatically(c.index, 'base'));
    if (ids.length) this.command(m => ids.forEach(i => m.resolveChangeAutomatically(i, 'base')));
  }

  /** The editor context menu (MergeThreesideViewer.createEditorPopupActions); hidden actions are left out like IntelliJ. */
  contextMenu(pane: Pane, toggles: { compareClipboard: () => void; toggleCollapse: () => void; toggleSync: () => void }): MenuEntry[] {
    const model = this.model;
    const has = (enabled: (c: MergeChange, s: ChangeState) => boolean) => this.selectedChanges(pane, enabled).length > 0;
    const sideOpen = (side: Side) => (_c: MergeChange, s: ChangeState) => !isSideResolved(s, side);
    const items: MenuEntry[] = [];
    if (pane === 'left' || pane === 'result') {
      if (has(sideOpen('left')))
        items.push({ label: pane === 'result' ? t('Accept Left Side') : t('Accept'), icon: 'diff/arrowRight@14x14', shortcut: 'Ctrl+Alt+R', action: () => this.applySelected(pane, 'left', false) });
    }
    if (pane === 'right' || pane === 'result') {
      if (has(sideOpen('right')))
        items.push({ label: pane === 'result' ? t('Accept Right Side') : t('Accept'), icon: 'diff/arrow@14x14', shortcut: 'Ctrl+Alt+A', action: () => this.applySelected(pane, 'right', false) });
    }
    if ((pane === 'left' || pane === 'result') && has(sideOpen('left'))) items.push({ label: t('Resolve using Left'), action: () => this.applySelected(pane, 'left', true) });
    if ((pane === 'right' || pane === 'result') && has(sideOpen('right'))) items.push({ label: t('Resolve using Right'), action: () => this.applySelected(pane, 'right', true) });
    if (pane === 'left' && has(sideOpen('left'))) items.push({ label: t('Ignore'), icon: 'diff/remove@14x14', action: () => this.ignoreSelectedSide(pane, 'left') });
    if (pane === 'right' && has(sideOpen('right'))) items.push({ label: t('Ignore'), icon: 'diff/remove@14x14', action: () => this.ignoreSelectedSide(pane, 'right') });
    if (pane === 'result') {
      if (has(c => model.canResolveAutomatically(c.index, 'base'))) items.push({ label: t('Resolve Automatically'), icon: 'diff/magicResolve@14x14', action: () => this.resolveSelected() });
      if (has((_c, s) => !isResolved(s))) items.push({ label: t('Ignore'), icon: 'diff/remove@14x14', action: () => this.ignoreSelected() });
    }
    items.push({ separator: true });
    items.push({ label: t('Compare with Clipboard'), icon: 'actions/diffWithClipboard', action: toggles.compareClipboard });
    items.push({ separator: true });
    if (this.init.contextLines !== -1) items.push({ label: t('Collapse Unchanged Fragments'), checked: this.settings.collapseUnchanged, action: toggles.toggleCollapse });
    items.push({ label: t('Synchronize Scrolling'), checked: this.settings.syncScroll, action: toggles.toggleSync });
    return items;
  }

  selectionText(pane: Pane): string {
    const v = this.views[pane];
    const r = v.state.selection.main;
    if (!r.empty) return v.state.sliceDoc(r.from, r.to);
    return v.state.doc.toString();
  }

  // ---------------------------------------------------------------- navigation

  firstUnresolved(): number {
    const states = this.states;
    return this.changes.findIndex(c => !isResolved(states[c.index]));
  }

  canNavigate(dir: 1 | -1): boolean {
    const states = this.states;
    const line = this.views.result.state.doc.lineAt(this.views.result.state.selection.main.head).number - 1;
    const open = this.changes.filter(c => !isResolved(states[c.index]));
    return dir > 0 ? open.some(c => states[c.index].start > line) || open.length > 0 : open.some(c => states[c.index].start < line) || open.length > 0;
  }

  /** Previous / Next Difference (F7 / Shift+F7). */
  navigate(dir: 1 | -1) {
    const states = this.states;
    const line = this.views.result.state.doc.lineAt(this.views.result.state.selection.main.head).number - 1;
    const open = this.changes.filter(c => !isResolved(states[c.index])).map(c => c.index);
    if (!open.length) return;
    let target: number;
    if (dir > 0) target = open.find(i => states[i].start > line) ?? open[0];
    else target = [...open].reverse().find(i => states[i].end <= line && states[i].start < line) ?? open[open.length - 1];
    this.goTo(target, true);
  }

  goTo(i: number, focus: boolean) {
    if (i < 0 || !this.views) return;
    const st = this.states[i];
    const v = this.views.result;
    // Expand a folded fragment that hides the change.
    const pos = v.state.doc.line(Math.min(v.state.doc.lines, st.start + 1)).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    if (focus) v.focus();
    requestAnimationFrame(() => this.syncFrom('result'));
  }

  private mergeKeymap(pane: Pane) {
    return [
      { key: 'F7', run: () => (this.navigate(1), true) },
      { key: 'Shift-F7', run: () => (this.navigate(-1), true) },
      { key: 'Ctrl-Alt-ArrowDown', run: () => (this.navigate(1), true) },
      { key: 'Ctrl-Alt-ArrowUp', run: () => (this.navigate(-1), true) },
      // Diff.ApplyLeftSide / Diff.ApplyRightSide: consumed even when there is nothing to do.
      { key: 'Ctrl-Alt-r', run: () => (pane !== 'right' && this.applySelected(pane, 'left', false), true) },
      { key: 'Ctrl-Alt-a', run: () => (pane !== 'left' && this.applySelected(pane, 'right', false), true) },
    ];
  }

  // ---------------------------------------------------------------- highlighting, operations, folding

  /** Recomputes decorations, gutter operations and folding from the current model. */
  refresh() {
    if (!this.views) return;
    const states = this.states;
    const model = this.model;
    const regions: Record<Pane, Region[]> = { left: [], result: [], right: [] };
    const ops: Record<Pane, { line: number; ops: Operation[] }[]> = { left: [], result: [], right: [] };
    const resultDoc = this.views.result.state.doc;
    const words = this.settings.highlight === 'words';
    const policy = this.settings.ignore === 'whitespace' ? 'ignoreWhitespaces' : 'default';
    for (const c of this.changes) {
      const st = states[c.index];
      const resolved = isResolved(st);
      let inner: ReturnType<typeof innerDifferences> | undefined;
      if (words && !resolved && (c.kind === 'modified' || c.kind === 'conflict')) {
        const lt = linesContent(this.sides.left, c.left);
        const bt = linesContent(model.lines, [st.start, st.end]);
        const rt = linesContent(this.sides.right, c.right);
        if (lt.length + bt.length + rt.length < 20000) inner = innerDifferences(lt, bt, rt, policy);
      }
      regions.result.push({ l0: st.start, l1: st.end, kind: c.kind, resolved, inner: inner?.base });
      for (const side of ['left', 'right'] as Side[]) {
        if (!isChange(c, side)) continue;
        const sideResolved = isSideResolved(st, side);
        regions[side].push({ l0: c[side][0], l1: c[side][1], kind: c.kind, resolved: sideResolved, inner: inner?.[side] });
        if (!sideResolved) {
          const tip = (text: string) => (c.kind === 'conflict' ? t('{0}\nCtrl+click to resolve conflict', text) : text);
          const apply: Operation = {
            i: c.index,
            action: 'apply',
            side,
            icon: side === 'left' ? (st.oneside ? ICONS.appendLeft : ICONS.applyLeft) : st.oneside ? ICONS.appendRight : ICONS.applyRight,
            tooltip: tip(t('Accept')),
          };
          const ignore: Operation = { i: c.index, action: 'ignore', side, icon: ICONS.ignore, tooltip: tip(t('Ignore')) };
          ops[side].push({ line: c[side][0], ops: [apply, ignore] });
        }
      }
      if (c.kind === 'conflict' && model.canResolveAutomatically(c.index, 'base')) {
        ops.result.push({ line: st.start, ops: [{ i: c.index, action: 'resolve', side: 'result', icon: ICONS.resolve, tooltip: t('Resolve') }] });
      }
    }
    const h = this.settings.highlight;
    const url = (icon: string) => iconUrl(icon, this.dark);
    const folds = this.computeFolds();
    for (const p of ['left', 'result', 'right'] as Pane[]) {
      const v = this.views[p];
      const doc = v.state.doc;
      v.dispatch({
        effects: [
          setDecorations.of(buildDecorations(doc, regions[p], h)),
          setGutterClasses.of(gutterClasses(doc, regions[p])),
          setOperations.of(buildOperations(doc, ops[p], url)),
          setFolds.of(buildFolds(doc, folds[p])),
        ],
      });
    }
    this.schedule();
  }

  setHighlight(h: MergeSettings['highlight']) {
    this.settings = { ...this.settings, highlight: h };
    this.refresh();
  }

  setCollapse(collapse: boolean) {
    this.settings = { ...this.settings, collapseUnchanged: collapse };
    this.expandedGroups.clear();
    this.refresh();
  }

  expandFold(group: number) {
    this.expandedGroups.add(group);
    this.refresh();
  }

  /** FoldingModelSupport: unchanged fragments longer than twice the context are collapsed in all three editors. */
  private computeFolds(): Record<Pane, Fold[]> {
    const out: Record<Pane, Fold[]> = { left: [], result: [], right: [] };
    const ctx = this.init.contextLines;
    if (!this.settings.collapseUnchanged || ctx < 0) return out;
    const states = this.states;
    const ranges: Record<Pane, [number, number][]> = {
      left: this.changes.map(c => c.left),
      right: this.changes.map(c => c.right),
      result: this.changes.map(c => [states[c.index].start, states[c.index].end] as [number, number]),
    };
    for (const p of ['left', 'result', 'right'] as Pane[]) {
      const lineCount = this.views[p].state.doc.lines;
      const r = ranges[p];
      for (let g = 0; g <= r.length; g++) {
        if (this.expandedGroups.has(g)) continue;
        const gapStart = g === 0 ? 0 : r[g - 1][1];
        const gapEnd = g === r.length ? lineCount : r[g][0];
        const s = g === 0 ? 0 : gapStart + ctx;
        const e = g === r.length ? lineCount : gapEnd - ctx;
        if (e - s >= 2) out[p].push({ l0: s, l1: e, group: g });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- scrolling (SyncScrollSupport)

  private onScroll(p: Pane) {
    if (!this.syncing && this.settings.syncScroll) this.syncFrom(p);
    this.schedule();
  }

  /** Line correspondences between a side and the result: [sideLine, resultLine] anchors in order. */
  private anchors(side: Side): [number, number][] {
    const out: [number, number][] = [[0, 0]];
    const states = this.states;
    for (const c of this.changes) {
      out.push([c[side][0], states[c.index].start], [c[side][1], states[c.index].end]);
    }
    out.push([this.views[side].state.doc.lines, this.views.result.state.doc.lines]);
    return out;
  }

  private mapLine(line: number, from: Pane, to: Pane): number {
    if (from === to) return line;
    if (from !== 'result' && to !== 'result') return this.mapLine(this.mapLine(line, from, 'result'), 'result', to);
    const side = (from === 'result' ? to : from) as Side;
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

  /** Keeps the middle line of every pane on the same change. */
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
      const y = b.top + (b.height > 30 ? 0 : (target - n) * b.height);
      v.scrollDOM.scrollTop = y - v.scrollDOM.clientHeight / 2;
    }
    requestAnimationFrame(() => (this.syncing = false));
  }

  // ---------------------------------------------------------------- dividers (DiffDividerDrawUtil)

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
    if (n >= doc.lines) return v.lineBlockAt(doc.line(doc.lines).from).bottom + offset;
    return v.lineBlockAt(doc.line(n + 1).from).top + offset;
  }

  private paint() {
    if (!this.views) return;
    const states = this.states;
    const parts: Record<Side, string[]> = { left: [], right: [] };
    const h = this.hosts.result.clientHeight;
    const visible = (y0: number, y1: number) => y1 >= -20 && y0 <= h + 20;
    for (const c of this.changes) {
      const st = states[c.index];
      const ry0 = this.lineY('result', st.start);
      const ry1 = st.end === st.start ? ry0 : this.lineY('result', st.end);
      for (const side of ['left', 'right'] as Side[]) {
        if (!isChange(c, side)) continue;
        const sy0 = this.lineY(side, c[side][0]);
        const sy1 = c[side][1] === c[side][0] ? sy0 : this.lineY(side, c[side][1]);
        if (!visible(Math.min(sy0, ry0), Math.max(sy1, ry1))) continue;
        parts[side].push(connector(side, sy0, sy1, ry0, ry1, c.kind, isSideResolved(st, side)));
      }
    }
    this.dividers[0].innerHTML = parts.left.join('');
    this.dividers[1].innerHTML = parts.right.join('');
  }
}

class SpacerMarker extends GutterMarker {
  constructor(readonly count: number) {
    super();
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = 'mg-ops';
    el.style.width = `${this.count * 16}px`;
    return el;
  }
}

function buildOperations(doc: Text, items: { line: number; ops: Operation[] }[], url: (icon: string) => string) {
  const b = new RangeSetBuilder<GutterMarker>();
  const byLine = new Map<number, Operation[]>();
  for (const it of items) {
    const line = Math.min(it.line, doc.lines - 1);
    byLine.set(line, [...(byLine.get(line) ?? []), ...it.ops]);
  }
  for (const [line, ops] of [...byLine].sort((a, z) => a[0] - z[0])) {
    const pos = doc.line(line + 1).from;
    b.add(pos, pos, new OperationsMarker(ops, url));
  }
  return b.finish();
}

const W = 30;

/**
 * IntelliJ's curved divider polygon between a side range and the result range: filled while unresolved,
 * a dotted outline once resolved (DiffDividerDrawUtil.ResolvablePainter).
 */
function connector(side: Side, sy0: number, sy1: number, ry0: number, ry1: number, kind: string, resolved: boolean): string {
  // Left divider: side on x=0, result on x=W. Right divider: result on x=0, side on x=W.
  const [x0, y00, y01, x1, y10, y11] = side === 'left' ? [0, sy0, sy1, W, ry0, ry1] : [0, ry0, ry1, W, sy0, sy1];
  const mx = (x0 + x1) / 2;
  const top = `M${x0},${y00} C${mx},${y00} ${mx},${y10} ${x1},${y10}`;
  const empty = y00 === y01 && y10 === y11;
  const cls = `mg-${kind}${resolved ? ' mg-resolved' : ''}`;
  if (empty) return `<path class="mg-conn-line ${cls}" d="${top}"/>`;
  const bottom = `M${x1},${y11} C${mx},${y11} ${mx},${y01} ${x0},${y01}`;
  if (resolved) return `<path class="mg-conn-line ${cls}" d="${top}"/><path class="mg-conn-line ${cls}" d="${bottom}"/>`;
  const d = `${top} L${x1},${y11} C${mx},${y11} ${mx},${y01} ${x0},${y01} Z`;
  return `<path class="mg-conn ${cls}" d="${d}"/>`;
}
