import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { getExtensionUri, WebviewConnection } from '../../host/webviewHost';
import { LhDiff, LhDiffMode, LhFile, LhInit, LhItem, LhMode } from '../../shared/localHistoryProtocol';
import { diffLines, mapRangeBack, splitLines, unifiedDiff } from '../../shared/lineDiff';
import { createPatchDialog, PatchEntry } from '../commit/patchDialog';
import { LocalHistoryRecorder } from './recorder';
import { FileState, LhEvent, LocalHistoryStore, normPath } from './store';

export const LH_SCHEME = 'ideagittool-lh';

/** URI of a stored revision: the original path with the content hash (or "none") in the query. */
export function lhUri(p: string, state: FileState): vscode.Uri {
  return vscode.Uri.file(p).with({ scheme: LH_SCHEME, query: state ?? 'none' });
}

export interface LhTarget {
  mode: LhMode;
  /** File or directory (absolute, normalized); undefined for the project. */
  path?: string;
  /** Selection history: 0-based [start, end) lines in the current document. */
  selection?: [number, number];
}

const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * IntelliJ's Local History window (the "Activity" view): activity list on the left, diff on the right,
 * with Revert Selected and Later Changes, Revert Selection and Create Patch.
 */
export class LocalHistoryView {
  private readonly panel: vscode.WebviewPanel;
  private readonly conn: WebviewConnection;
  private readonly disposables: vscode.Disposable[] = [];
  private items: LhItem[] = [];

  constructor(
    private readonly recorder: LocalHistoryRecorder,
    private readonly target: LhTarget,
    private readonly memento: vscode.Memento,
    select?: number,
  ) {
    const title = this.title();
    this.panel = vscode.window.createWebviewPanel('ideagittool.localHistory', title, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'general', 'history.svg'),
      dark: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'general', 'history_dark.svg'),
    };
    const init: LhInit = {
      mode: target.mode,
      displayName: this.displayName(),
      lines: target.selection ? [target.selection[0] + 1, target.selection[1]] : undefined,
      showSystem: this.showSystem,
      select,
    };
    this.conn = new WebviewConnection(this.panel.webview, 'localHistory', () => init, title);
    this.conn.handleAll({
      items: (p: { showSystem: boolean }) => this.listItems(p.showSystem),
      setShowSystem: (v: boolean) => this.memento.update('ideagittool.localHistory.showSystem', v),
      diff: (p: { id: number; mode: LhDiffMode }) => this.diff(p.id, p.mode),
      openDiff: (p: { id: number; mode: LhDiffMode; path?: string }) => this.openDiff(p.id, p.mode, p.path),
      revert: (p: { id: number }) => this.revert(p.id),
      revertSelection: (p: { id: number }) => this.revertSelection(p.id),
      createPatch: (p: { id: number; mode: LhDiffMode }) => this.createPatch(p.id, p.mode),
      openFile: (p: { path: string }) => vscode.window.showTextDocument(vscode.Uri.file(p.path)),
    });
    recorder.onDidRecord(() => this.conn.post('changed'), null, this.disposables);
    this.panel.onDidDispose(() => {
      this.conn.dispose();
      this.disposables.forEach(d => d.dispose());
    });
  }

  get showSystem(): boolean {
    return this.memento.get<boolean>('ideagittool.localHistory.showSystem', false);
  }

  private get store(): LocalHistoryStore {
    return this.recorder.store;
  }

  private displayName(): string {
    if (this.target.mode === 'project') return (vscode.workspace.workspaceFolders ?? []).map(f => f.name).join(', ') || translate('Project');
    return path.posix.basename(this.target.path ?? '');
  }

  private title(): string {
    const name = this.displayName();
    if (this.target.selection) return translate('Local History: {0} ({1}-{2})', name, this.target.selection[0] + 1, this.target.selection[1]);
    return translate('Local History: {0}', name);
  }

  private scope() {
    return this.target.path ? { path: this.target.path, dir: this.target.mode === 'dir' } : undefined;
  }

  private rel(p: string): string {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const root = normPath(f.uri.fsPath);
      if (p.startsWith(root + '/')) return (vscode.workspace.workspaceFolders!.length > 1 ? f.name + '/' : '') + p.slice(root.length + 1);
    }
    return p;
  }

  // ------------------------------------------------------------------ items

  listItems(showSystem: boolean): LhItem[] {
    const scope = this.scope();
    const events = this.store.eventsFor(scope?.path, scope?.dir).filter(e => showSystem || e.kind !== 'system');
    const items: LhItem[] = [];
    if (this.target.mode === 'file' || this.target.mode === 'selection') {
      for (const e of events) items.push(this.itemOf([e]));
    } else {
      // Group the events of one action (save all, git operation) into one item.
      const groups = new Map<number, LhEvent[]>();
      for (const e of events) {
        const key = e.kind === 'label' || e.kind === 'system' ? -e.id : e.group;
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
      for (const list of groups.values()) items.push(this.itemOf(list));
    }
    items.sort((a, b) => b.id - a.id);
    this.items = this.target.mode === 'selection' ? this.filterSelection(items) : items;
    return this.items;
  }

  private itemOf(list: LhEvent[]): LhItem {
    const first = list[0];
    const last = list[list.length - 1];
    const base = { id: first.id, lastId: last.id, ts: last.ts };
    if (first.kind === 'label' || first.kind === 'system') return { ...base, kind: first.kind, title: first.label ?? '', files: 0, paths: [] };
    const paths = [...new Set(list.flatMap(LocalHistoryStore.paths))];
    const name = (p?: string) => path.posix.basename(p ?? '');
    let title: string;
    if (list.length === 1) {
      const e = first;
      if (e.kind === 'create') title = translate('Create {0}', name(e.path));
      else if (e.kind === 'delete') title = translate('Delete {0}', name(e.path));
      else if (e.kind === 'rename')
        title =
          path.posix.dirname(e.oldPath!) === path.posix.dirname(e.path!)
            ? translate('Rename {0} to {1}', name(e.oldPath), name(e.path))
            : translate('Move {0} to {1}', name(e.oldPath), this.rel(path.posix.dirname(e.path!)));
      else title = e.external ? translate('External change') : this.target.mode === 'file' || this.target.mode === 'selection' ? translate('Change') : translate('Change {0}', name(e.path));
    } else {
      const files = list.filter(e => e.path).map(e => name(e.path));
      title = list.every(e => e.external)
        ? translate('External change')
        : files.length > 1
          ? translate('Change {0} + {1} more', files[0], files.length - 1)
          : translate('Change {0}', files[0] ?? '');
    }
    return { ...base, kind: list.every(e => e.external) ? 'external' : 'change', title, files: list.filter(e => e.path).length, paths: paths.map(p => this.rel(p)) };
  }

  // ------------------------------------------------------------------ content

  private read(state: FileState, p: string): { text?: string; missing?: boolean; unavailable?: boolean } {
    if (state === null) return { missing: true };
    if (state === undefined) return this.current(p);
    const data = this.store.getContent(state);
    return data ? { text: data.toString('utf8') } : { unavailable: true };
  }

  /** Current content: the open document (with unsaved changes) or the file on disk. */
  private current(p: string): { text?: string; missing?: boolean } {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && normPath(d.uri.fsPath) === p);
    if (doc) return { text: doc.getText() };
    try {
      return { text: fs.readFileSync(p, 'utf8') };
    } catch {
      return { missing: true };
    }
  }

  private currentState(p: string): FileState {
    return this.recorder.readState(p);
  }

  /** State of `p` on the right side of the diff: current (local) or after the item (next). */
  private rightState(p: string, item: LhItem, mode: LhDiffMode): FileState {
    return mode === 'local' ? undefined : this.store.stateBefore(p, item.lastId + 1);
  }

  private item(id: number): LhItem {
    const it = this.items.find(i => i.id === id);
    if (!it) throw new Error(translate('The revision is not available'));
    return it;
  }

  diff(id: number, mode: LhDiffMode): LhDiff {
    const item = this.item(id);
    const date = dayFmt.format(new Date(item.ts));
    if (this.target.mode === 'file' || this.target.mode === 'selection') {
      const p = this.target.path!;
      const left = this.read(this.store.stateBefore(p, item.id), p);
      const right = this.read(this.rightState(p, item, mode), p);
      const leftTitle = item.kind === 'label' || item.kind === 'system' ? translate("Before '{0}'", item.title) : translate('Before {0}', date);
      const rightTitle = mode === 'local' ? translate('Current') : translate('After {0}', date);
      if (this.target.mode === 'selection') {
        const cur = splitLines(this.current(p).text ?? '');
        const [s, e] = this.target.selection!;
        const block = (text?: string) => {
          if (text === undefined) return undefined;
          const lines = splitLines(text);
          const [a0, a1] = mapRangeBack(diffLines(lines, cur), s, e);
          return { text: lines.slice(a0, a1).join('\n'), firstLine: a0 + 1 };
        };
        const l = block(left.text);
        const r = mode === 'local' ? { text: cur.slice(s, e).join('\n'), firstLine: s + 1 } : block(right.text);
        return { kind: 'text', left: { title: leftTitle, ...left, ...l }, right: { title: rightTitle, ...right, ...r } };
      }
      return { kind: 'text', left: { title: leftTitle, ...left }, right: { title: rightTitle, ...right } };
    }
    const files = this.changedFiles(item, mode);
    if (!files.length) return { kind: 'empty', text: translate('No changes detected') };
    return { kind: 'files', files };
  }

  private changedFiles(item: LhItem, mode: LhDiffMode): LhFile[] {
    const scope = this.scope();
    const candidates = mode === 'local' ? this.store.pathsChangedSince(item.id, scope) : this.store.pathsChangedSince(item.id, scope).filter(p => this.store.events.some(e => e.id >= item.id && e.id <= item.lastId && LocalHistoryStore.paths(e).includes(p)));
    const out: LhFile[] = [];
    for (const p of candidates) {
      const before = this.store.stateBefore(p, item.id);
      const after = mode === 'local' ? this.currentState(p) : this.rightState(p, item, mode);
      if (before === undefined || before === after) continue;
      out.push({ path: p, rel: this.rel(p), status: before === null ? 'A' : after === null ? 'D' : 'M' });
    }
    return out;
  }

  private filterSelection(items: LhItem[]): LhItem[] {
    const p = this.target.path!;
    const cur = splitLines(this.current(p).text ?? '');
    const [s, e] = this.target.selection!;
    const block = (state: FileState) => {
      const text = this.read(state, p).text;
      if (text === undefined) return '\0missing';
      const lines = splitLines(text);
      const [a0, a1] = mapRangeBack(diffLines(lines, cur), s, e);
      return lines.slice(a0, a1).join('\n');
    };
    return items.filter(it => it.kind === 'label' || it.kind === 'system' || block(this.store.stateBefore(p, it.id)) !== block(this.store.stateBefore(p, it.lastId + 1)));
  }

  async openDiff(id: number, mode: LhDiffMode, file?: string) {
    const item = this.item(id);
    const p = file ?? this.target.path;
    if (!p) return;
    const left = lhUri(p, this.store.stateBefore(p, item.id));
    const rightState = this.rightState(p, item, mode);
    const right = rightState === undefined ? vscode.Uri.file(p) : lhUri(p, rightState);
    const date = dayFmt.format(new Date(item.ts));
    const title = mode === 'local' ? translate('{0} (Before {1} ↔ Current)', path.posix.basename(p), date) : translate('{0} (Before {1} ↔ After)', path.posix.basename(p), date);
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  // ------------------------------------------------------------------ actions

  /** Revert Selected and Later Changes. */
  async revert(id: number) {
    const item = this.item(id);
    const scope = this.scope();
    const states = this.store
      .pathsChangedSince(item.id, scope)
      .map(p => ({ path: p, state: this.store.stateBefore(p, item.id) }))
      .filter(s => s.state !== undefined && s.state !== this.currentState(s.path));
    if (!states.length) {
      void vscode.window.showInformationMessage(translate('Nothing to revert'));
      return;
    }
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && states.some(s => s.path === normPath(d.uri.fsPath)));
    if (dirty.length) {
      const a = await vscode.window.showWarningMessage(
        dirty.length === 1
          ? translate('Cannot revert because {0} has unsaved changes.', path.basename(dirty[0].uri.fsPath))
          : translate('Cannot revert because {0} files have unsaved changes.', dirty.length),
        { modal: true, detail: translate('Save or discard the changes first.') },
        translate('Save and Revert'),
      );
      if (!a) return;
      await Promise.all(dirty.map(d => d.save()));
    }
    const date = dayFmt.format(new Date(item.ts));
    const label = item.kind === 'label' || item.kind === 'system' ? translate("Revert to '{0}' at {1}", item.title, date) : translate('Revert to {0}', date);
    await this.recorder.apply(states, label);
    void vscode.window.setStatusBarMessage(
      states.length === 1 ? translate('{0}: {1} file reverted', label, states.length) : translate('{0}: {1} files reverted', label, states.length),
      5000,
    );
  }

  /** Revert Selection (selection history): puts the selected block of the revision into the document. */
  async revertSelection(id: number) {
    const item = this.item(id);
    const p = this.target.path!;
    const [s, e] = this.target.selection!;
    const text = this.read(this.store.stateBefore(p, item.id), p).text;
    if (text === undefined) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    const cur = splitLines(doc.getText());
    const lines = splitLines(text);
    const [a0, a1] = mapRangeBack(diffLines(lines, cur), s, e);
    const block = lines.slice(a0, a1);
    const edit = new vscode.WorkspaceEdit();
    const end = e >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(e, 0);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    edit.replace(doc.uri, new vscode.Range(new vscode.Position(s, 0), end), block.join(eol) + (e >= doc.lineCount || !block.length ? '' : eol));
    await vscode.workspace.applyEdit(edit);
    this.target.selection = [s, s + block.length];
    this.conn.post('changed');
  }

  async createPatch(id: number, mode: LhDiffMode) {
    const item = this.item(id);
    const files: LhFile[] =
      this.target.mode === 'file' || this.target.mode === 'selection'
        ? [{ path: this.target.path!, rel: this.rel(this.target.path!), status: 'M' }]
        : this.changedFiles(item, mode);
    const basePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(files[0]?.path ?? '');
    const entries: PatchEntry[] = files.map(f => ({ root: basePath, path: f.rel, status: f.status, key: f.path }));
    await createPatchDialog({
      files: entries,
      name: `Local_History_${new Date(item.ts).toISOString().slice(0, 16).replace(/[-:T]/g, '')}`,
      basePath,
      rootLabel: translate('Changes'),
      produce: async (keys, opts) => {
        let out = '';
        for (const p of keys) {
          const before = this.read(this.store.stateBefore(p, item.id), p);
          const after = this.read(this.rightState(p, item, mode), p);
          if (before.unavailable || after.unavailable) throw new Error(translate('Cannot create patch because content of some\nof the selected files was not stored due to its big size.'));
          const rel = path.relative(opts.basePath, p).replace(/\\/g, '/');
          let [a, b] = [before, after];
          if (opts.reverse) [a, b] = [b, a];
          out += unifiedDiff(a.missing ? undefined : rel, b.missing ? undefined : rel, splitLines(a.text ?? ''), splitLines(b.text ?? ''));
        }
        return out;
      },
    });
  }
}
