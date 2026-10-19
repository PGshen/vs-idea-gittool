import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { shortHash, toGitUri } from '../../host/gitContent';
import { confirmDialog, notifySuccess } from '../../host/ui';
import { WebviewConnection } from '../../host/webviewHost';
import { changeKey } from '../../shared/commitProtocol';
import { joinText, MergeModel, splitText } from '../../shared/mergeModel';
import { MergeFinish, TitleParts } from '../../shared/mergeProtocol';
import { Change } from '../../shared/types';
import { acceptSide, addFiles, conflictKind } from './gitOps';
import { isBinary, MergeTool } from './mergeTool';

/** A row of the Conflicts dialog. */
export interface ConflictRow {
  key: string;
  root: string;
  repoName: string;
  path: string;
  kind: string;
  yours: 'Modified' | 'Deleted';
  theirs: 'Modified' | 'Deleted';
  /** "resolved/total" badge, shown once the file has a merge model. */
  badge?: { resolved: number; total: number };
  /** All changes resolved: shown in the "Resolved" group, staged by "Accept and Finish". */
  resolved: boolean;
  /** Can be merged in the three-pane window (text on both sides). */
  mergeable: boolean;
  reviewed: boolean;
}

export interface ConflictsPayload {
  rows: ConflictRow[];
  text: string;
  yours: string;
  theirs: string;
  /** After "Resolve All Simple Conflicts" pressed once, the Resolved group is shown even when empty. */
  showResolvedGroup: boolean;
  status: string;
  /** Every file is resolved and was reviewed: "All conflicts have been resolved". */
  allResolvedAndReviewed: boolean;
  canFinish: boolean;
  canResolveAutomatically: boolean;
  /** "Resolve All Simple Conflicts" is running: the table is disabled. */
  busy: boolean;
}

/**
 * What the conflicts come from when git does not record an operation (MergeDialogCustomizer and
 * GitConflictResolver.Params.setReverse): restoring stashed or shelved changes after Smart Merge / Checkout /
 * Update, or Unstash / Unshelve.
 */
export interface ConflictContext {
  /** Text above the table, e.g. "Uncommitted changes that were saved before merge have conflicts with files from feature". */
  description: string;
  /** Titles of the left and right panes of the merge window. */
  left: TitleParts;
  right: TitleParts;
  /** "Yours" is git's "theirs" (stage 3): the saved changes are applied onto the result of the operation. */
  reverse: boolean;
}

/** Result of the Conflicts dialog: conflicts left in the repositories it was shown for. */
export interface ConflictsResult {
  remaining: number;
}

/**
 * Merge model of a file in the iterative flow (MergeConflictModel kept by MergeConflictIterativeDataHolder):
 * the result written to the work tree file and the per-change state.
 */
interface FileModel {
  model: MergeModel;
  crlf: boolean;
  wasReviewed: boolean;
  /** The work tree file holds a (partial) merge result written by the dialog. */
  saved: boolean;
}

/**
 * The Conflicts dialog (MultipleFileMergeDialog) in the iterative flow (registry
 * `vcs.merge.conflict.iterative.resolution`, on in IdeaGitTool) and the three-pane merge window.
 */
export class ConflictsController {
  /**
   * Files open in VS Code's merge editor (setting `ideagittool.merge.useVsCodeMergeEditor`), with the file content
   * when the editor was opened. A file is marked resolved when its merge editor is closed with a changed,
   * saved result without conflict markers.
   */
  private readonly pending = new Map<string, { root: string; path: string; initial: string }>();
  private dialog: WebviewConnection | undefined;
  private readonly mergeTool: MergeTool;
  private readonly models = new Map<string, FileModel>();
  /** Keys of the files the dialog was opened for. */
  private files: string[] = [];
  private resolvePressedOnce = false;
  private status = '';
  private busy = false;
  /**
   * Context of the conflicts of a repository without an ongoing operation, kept while the conflicts remain, so
   * that the dialog and the merge window opened later (notification, editor, Commit tool window) show the same texts.
   */
  private readonly contexts = new Map<string, ConflictContext>();

  constructor(private readonly ctx: Ctx) {
    this.mergeTool = new MergeTool(ctx);
    ctx.extension.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(e => {
        for (const tab of e.closed) {
          const result = mergeResult(tab.input);
          if (result) void this.onMergeEditorClosed(result);
        }
      }),
      ctx.repos.onDidChangeRepository(() => this.pushRows()),
    );
  }

  private conflicts(root?: string): Change[] {
    return this.ctx.repos.repositories.filter(r => !root || r.root === root).flatMap(r => r.status.conflicts);
  }

  /** The context of a repository's conflicts; forgotten when they are resolved or an operation starts. */
  private context(repo: Repository | undefined): ConflictContext | undefined {
    if (!repo) return undefined;
    const c = this.contexts.get(repo.root);
    if (c && (repo.info.operation !== 'none' || !repo.status.conflicts.length)) {
      this.contexts.delete(repo.root);
      return undefined;
    }
    return c;
  }

  /** Whether "yours" is git's "theirs": during a rebase git's "ours" is the branch being rebased onto. */
  private reversed(repo: Repository | undefined) {
    return this.context(repo)?.reverse ?? repo?.info.operation === 'rebase';
  }

  private sides(c: Change) {
    const repo = this.ctx.repos.get(c.root);
    const xy = `${c.index}${c.workTree}`;
    const oursDeleted = xy === 'DU' || xy === 'DD' || xy === 'UA';
    const theirsDeleted = xy === 'UD' || xy === 'DD' || xy === 'AU';
    const rev = this.reversed(repo);
    return { yoursDeleted: rev ? theirsDeleted : oursDeleted, theirsDeleted: rev ? oursDeleted : theirsDeleted };
  }

  private current(): Change[] {
    const all = this.conflicts();
    return this.files.length ? all.filter(c => this.files.includes(changeKey(c))) : all;
  }

  private row(c: Change): ConflictRow {
    const repo = this.ctx.repos.get(c.root);
    const key = changeKey(c);
    const s = this.sides(c);
    const m = this.models.get(key);
    return {
      key,
      root: c.root,
      repoName: repo?.name ?? path.basename(c.root),
      path: c.path,
      kind: conflictKind(`${c.index}${c.workTree}`),
      yours: s.yoursDeleted ? 'Deleted' : 'Modified',
      theirs: s.theirsDeleted ? 'Deleted' : 'Modified',
      badge: m ? { resolved: m.model.resolvedCount(), total: m.model.changes.length } : undefined,
      resolved: !!m && m.model.unresolved.length === 0,
      mergeable: !s.yoursDeleted && !s.theirsDeleted,
      reviewed: !!m?.wasReviewed,
    };
  }

  /** "Merging branch feature into branch master" and the like. */
  description(): { text: string; yours: string; theirs: string } {
    const repo = this.ctx.repos.repositories.find(r => r.status.conflicts.length) ?? this.ctx.repos.repositories[0];
    if (!repo) return { text: '', yours: 'Yours', theirs: 'Theirs' };
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(repo.gitDir, f), 'utf8').trim();
      } catch {
        return undefined;
      }
    };
    const context = this.context(repo);
    if (context) return { text: context.description, yours: 'Yours', theirs: 'Theirs' };
    const branch = repo.info.branch ?? repo.info.rebaseHeadName ?? shortHash(repo.info.headHash ?? '');
    switch (repo.info.operation) {
      case 'merge': {
        const other = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG') ?? '')?.[1] ?? shortHash(read('MERGE_HEAD') ?? '');
        return { text: `Merging branch ${other} into branch ${branch}`, yours: `Yours (${branch})`, theirs: `Theirs (${other})` };
      }
      case 'rebase': {
        const onto = shortHash(read('rebase-merge/onto') ?? read('rebase-apply/onto') ?? '');
        const head = repo.info.rebaseHeadName;
        return { text: `Rebasing${head ? ` branch ${head}` : ''} onto ${onto}`, yours: `Yours${head ? ` (${head})` : ''}`, theirs: `Theirs (${onto})` };
      }
      case 'cherry-pick': {
        const h = read('CHERRY_PICK_HEAD') ?? '';
        return { text: `Conflicts during cherry-picking commit ${shortHash(h)}`, yours: 'Yours', theirs: `Theirs (${shortHash(h)})` };
      }
      case 'revert': {
        const h = read('REVERT_HEAD') ?? '';
        return { text: `Conflicts during reverting commit ${shortHash(h)}`, yours: 'Yours', theirs: 'Theirs' };
      }
      default: {
        const n = this.current().length;
        return { text: `The following ${n === 1 ? 'file has' : 'files have'} conflicts:`, yours: 'Yours', theirs: 'Theirs' };
      }
    }
  }

  private payload(): ConflictsPayload {
    const rows = this.current().map(c => this.row(c));
    const iterative = rows.filter(r => r.mergeable);
    const allResolved = rows.length > 0 && rows.every(r => r.resolved);
    return {
      rows,
      ...this.description(),
      showResolvedGroup: this.resolvePressedOnce,
      status: this.status,
      allResolvedAndReviewed: allResolved && rows.every(r => r.reviewed),
      canFinish: !this.busy && rows.length > 0 && rows.every(r => r.resolved),
      canResolveAutomatically: this.canResolveAutomatically(rows, iterative),
      busy: this.busy,
    };
  }

  /** IterativeMergeFlowDelegate.updateButtonsState for "Resolve All Simple Conflicts". */
  private canResolveAutomatically(rows: ConflictRow[], iterative: ConflictRow[]): boolean {
    if (this.busy) return false;
    const autoResolvable = [...this.models.values()].some(m => m.model.hasAutoResolvableChanges());
    if (autoResolvable) return true;
    if (rows.every(r => r.resolved)) return false;
    if (!this.resolvePressedOnce) return iterative.length > 0;
    return false;
  }

  private pushRows() {
    this.dialog?.post('rows', this.payload());
  }

  // ---------------------------------------------------------------- models

  private async revisions(c: Change) {
    const repo = this.ctx.repos.get(c.root)!;
    const rev = this.reversed(repo);
    const [base, yours, theirs] = await Promise.all([repo.show(':1', c.path), repo.show(rev ? ':3' : ':2', c.path), repo.show(rev ? ':2' : ':3', c.path)]);
    return { base, yours, theirs };
  }

  /** MergeConflictIterativeDataHolder.prepareModelIfSupported: text files only. */
  private async prepareModel(c: Change): Promise<FileModel | undefined> {
    const key = changeKey(c);
    const existing = this.models.get(key);
    if (existing) return existing;
    if (!this.row(c).mergeable) return undefined;
    const r = await this.revisions(c);
    if (isBinary(r.base) || isBinary(r.yours) || isBinary(r.theirs)) return undefined;
    const b = splitText(r.base.toString('utf8'));
    const l = splitText(r.yours.toString('utf8'));
    const t = splitText(r.theirs.toString('utf8'));
    const model = MergeModel.create(b.lines, l.lines, t.lines, this.mergeTool.settings().ignore);
    const fm: FileModel = { model, crlf: l.crlf || t.crlf || b.crlf, wasReviewed: false, saved: false };
    this.models.set(key, fm);
    return fm;
  }

  /** Writes the model result to the work tree file (FileDocumentManager.saveDocument). */
  private save(c: Change, fm: FileModel) {
    fs.writeFileSync(path.join(c.root, c.path), joinText(fm.model.lines, fm.crlf));
    fm.saved = true;
  }

  // ---------------------------------------------------------------- dialog

  /**
   * Shows the Conflicts dialog and resolves when it is closed. `keys` limits it to some files (Merge… in the
   * changes view); `context` describes conflicts without an ongoing git operation (see ConflictContext).
   */
  async show(root?: string, keys?: string[], context?: ConflictContext, opts: { openMerge?: boolean } = {}): Promise<ConflictsResult> {
    await this.ctx.repos.ready();
    await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
    if (context && root) this.contexts.set(root, context);
    const conflicts = this.conflicts(root);
    if (!conflicts.length) {
      void vscode.window.showInformationMessage('No conflicts to resolve');
      return { remaining: 0 };
    }
    if (this.dialog) {
      this.dialog.post('reveal');
      const open = opts.openMerge && keys ? this.current().filter(c => keys.includes(changeKey(c))) : [];
      if (open.length) await this.resolveManually(open.map(c => changeKey(c)));
      return { remaining: conflicts.length };
    }
    this.files = conflicts.map(c => changeKey(c)).filter(k => !keys || keys.includes(k));
    this.models.clear();
    this.resolvePressedOnce = false;
    this.status = '';
    let closing = false;
    await showDialog('commit.conflicts', this.payload(), {
      title: 'Conflicts',
      onOpen: conn => {
        this.dialog = conn;
        // Resolve Conflicts… in the editor: the merge window of the file opens over the dialog.
        if (opts.openMerge) setTimeout(() => void this.resolveManually(this.files), 0);
      },
      handlers: {
        load: () => this.payload(),
        open: (p: { keys: string[] }) => this.resolveManually(p.keys),
        accept: (p: { keys: string[]; yours: boolean }) => this.accept(p.keys, p.yours),
        revert: (p: { keys: string[] }) => this.revertResolution(p.keys),
        resolveAutomatically: () => this.resolveAutomatically(),
        acceptAndFinish: async () => {
          closing = true;
          await this.finishResolution();
          this.dialog?.post('close');
        },
        close: async () => {
          const partial = [...this.models.values()].some(m => m.model.resolvedCount() > 0 && m.model.unresolved.length > 0);
          if (partial) {
            const a = await vscode.window.showWarningMessage(
              'Discard Changes?',
              { modal: true, detail: 'Closing the dialog will discard your changes in partially resolved files' },
              'Discard Changes',
              'Continue Merge',
            );
            if (a !== 'Discard Changes') return false;
          }
          closing = true;
          await this.finishResolution();
          this.dialog?.post('close');
          return true;
        },
      },
    });
    // Closed with the window's X: like doCancelAction.
    if (!closing) await this.finishResolution();
    this.dialog = undefined;
    this.models.clear();
    this.files = [];
    await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
    return { remaining: this.conflicts(root).length };
  }

  /**
   * MultipleFileMergeDialog.finishResolution: resolved files are marked resolved in git (staged);
   * partially merged results are discarded and the conflict is restored.
   */
  private async finishResolution() {
    const byRoot = new Map<string, { add: string[]; restore: string[] }>();
    for (const c of this.current()) {
      const m = this.models.get(changeKey(c));
      if (!m) continue;
      const entry = byRoot.get(c.root) ?? { add: [], restore: [] };
      if (m.model.unresolved.length === 0) entry.add.push(c.path);
      else if (m.saved) entry.restore.push(c.path);
      byRoot.set(c.root, entry);
    }
    for (const [root, { add, restore }] of byRoot) {
      const repo = this.ctx.repos.get(root);
      if (!repo) continue;
      await repo.batch(async () => {
        if (add.length) await addFiles(repo, add, true);
        if (restore.length) await repo.exec(['checkout', '-m', '--', ...restore], { allowFailure: true });
      });
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.pushRows();
  }

  /** getFilesToOpen: selected files, then unresolved ones, then resolved ones not reviewed yet. */
  private filesToOpen(selected: string[]): Change[] {
    const current = this.current();
    const rows = new Map(current.map(c => [changeKey(c), this.row(c)]));
    const sel = current.filter(c => selected.includes(changeKey(c)));
    const unresolved = current.filter(c => !rows.get(changeKey(c))!.resolved);
    const notReviewed = current.filter(c => rows.get(changeKey(c))!.resolved && !rows.get(changeKey(c))!.reviewed);
    const out: Change[] = [];
    for (const c of [...sel, ...unresolved, ...notReviewed]) if (!out.includes(c)) out.push(c);
    return out;
  }

  /** "Resolve Manually" / "Review Changes" / double click: opens the merge window file after file. */
  async resolveManually(selected: string[]) {
    for (const c of this.filesToOpen(selected)) {
      const r = await this.openMerge(c);
      this.pushRows();
      if (r === 'CANCEL') return;
    }
  }

  /** Opens one file; returns the merge result. */
  private async openMerge(c: Change): Promise<MergeFinish['result']> {
    const repo = this.ctx.repos.get(c.root);
    if (!repo) return 'CANCEL';
    if (vscode.workspace.getConfiguration('ideagittool').get<boolean>('merge.useVsCodeMergeEditor', false)) {
      await this.openVsCodeMergeEditor(c);
      return 'CANCEL';
    }
    const fm = await this.prepareModel(c);
    if (!fm) return this.chooseSide(c);
    const r = await this.revisions(c);
    const context = this.context(repo);
    const finish = await this.mergeTool.open(
      repo,
      c,
      { base: r.base.toString('utf8'), left: r.yours.toString('utf8'), right: r.theirs.toString('utf8') },
      {
        iterative: true,
        progress: { lines: fm.model.lines, states: fm.model.states, contentModified: fm.model.contentModified },
        titles: context && { left: context.left, right: context.right },
      },
    );
    const modified = finish.lines.length > 0 && (finish.contentModified || finish.lines.join('\n') !== fm.model.lines.join('\n'));
    if (finish.lines.length) {
      fm.model.lines = finish.lines;
      fm.model.states = finish.states;
      fm.model.contentModified = finish.contentModified;
    }
    // The merge callback: save unless cancelled without changes; the file was reviewed.
    if (finish.result !== 'CANCEL' || modified) this.save(c, fm);
    fm.wasReviewed = true;
    return finish.result;
  }

  /** Binary files and deleted / modified conflicts: IntelliJ's simple merge choice (BinaryMergeTool). */
  private async chooseSide(c: Change): Promise<MergeFinish['result']> {
    const s = this.sides(c);
    const d = this.description();
    const message =
      s.yoursDeleted || s.theirsDeleted
        ? `${c.path}\n\n${d.yours}: ${s.yoursDeleted ? 'deleted' : 'modified'}\n${d.theirs}: ${s.theirsDeleted ? 'deleted' : 'modified'}`
        : `${c.path} is a binary file. Choose the version to keep.`;
    const r = await confirmDialog({
      title: `Merge Revisions for ${c.path}`,
      message,
      icon: 'question',
      buttons: [
        { id: 'left', label: 'Accept Left' },
        { id: 'right', label: 'Accept Right' },
        { id: 'cancel', label: 'Cancel', primary: true },
      ],
    });
    if (!r || r.button === 'cancel') return 'CANCEL';
    await this.acceptInGit([c], r.button === 'left');
    return r.button === 'left' ? 'LEFT' : 'RIGHT';
  }

  /** Accepts a side through git (not mergeable files): the file leaves the dialog. */
  private async acceptInGit(list: Change[], yours: boolean) {
    const byRoot = new Map<string, Change[]>();
    for (const c of list) byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), c]);
    for (const [root, changes] of byRoot) {
      const repo = this.ctx.repos.get(root)!;
      const side = yours !== this.reversed(repo) ? 'ours' : 'theirs';
      await repo.batch(() => acceptSide(repo, changes, side));
    }
  }

  /** Accept 'Yours' / Accept 'Theirs' (acceptForResolution). */
  async accept(keys: string[], yours: boolean) {
    const list = this.current().filter(c => keys.includes(changeKey(c)));
    const iterative: { c: Change; fm: FileModel }[] = [];
    const other: Change[] = [];
    this.setBusy(true);
    try {
      for (const c of list) {
        const fm = await this.prepareModel(c);
        if (fm) iterative.push({ c, fm });
        else other.push(c);
      }
      if (other.length) await this.acceptInGit(other, yours);
      if (iterative.length && iterative.some(x => x.fm.model.resolvedCount() > 0)) {
        const d = this.description();
        const label = yours ? d.yours : d.theirs;
        const a = await vscode.window.showInformationMessage(
          'Overwrite Changes',
          {
            modal: true,
            detail: `${iterative.length === 1 ? 'This file already contains merged changes' : 'These files already contain merged changes'}. Accepting changes from ‘${label}’ will discard and overwrite them.`,
          },
          'Discard and Accept',
        );
        if (a !== 'Discard and Accept') return;
      }
      for (const { c, fm } of iterative) {
        fm.model.acceptRevisionForSide(yours ? 'left' : 'right');
        fm.model.takeEdits();
        fm.wasReviewed = true;
        this.save(c, fm);
      }
      this.status = '';
    } finally {
      this.setBusy(false);
    }
  }

  /** Revert Conflict Resolution (context menu): the files return to their original conflicted state. */
  async revertResolution(keys: string[]) {
    const n = keys.length;
    const a = await vscode.window.showInformationMessage(
      'Confirm Revert',
      { modal: true, detail: `All changes will be reverted. The ${n === 1 ? 'file will return to its' : 'selected files will return to their'} original conflicted state.` },
      'Revert',
    );
    if (a !== 'Revert') return;
    for (const c of this.current().filter(x => keys.includes(changeKey(x)))) {
      const fm = this.models.get(changeKey(c));
      if (!fm) continue;
      this.models.delete(changeKey(c));
      if (fm.saved) {
        const repo = this.ctx.repos.get(c.root)!;
        await repo.batch(() => repo.exec(['checkout', '-m', '--', c.path], { allowFailure: true }));
      }
    }
    this.status = '';
    this.pushRows();
  }

  /** "Resolve All Simple Conflicts": applies non-conflicting changes and resolves simple conflicts in every file. */
  async resolveAutomatically() {
    this.resolvePressedOnce = true;
    this.status = '';
    this.setBusy(true);
    try {
      const files = this.current().filter(c => !this.row(c).resolved);
      let resolvedBefore = 0;
      for (const fm of this.models.values()) resolvedBefore += fm.model.resolvedCount();
      for (const c of files) {
        const fm = await this.prepareModel(c);
        if (!fm) continue;
        if (fm.model.resolveAllChangesAutomatically()) {
          fm.model.takeEdits();
          fm.wasReviewed = false;
          this.save(c, fm);
        }
      }
      let resolved = 0;
      let unresolved = 0;
      let filesWithUnresolved = 0;
      for (const fm of this.models.values()) {
        resolved += fm.model.resolvedCount();
        unresolved += fm.model.unresolved.length;
        if (fm.model.unresolved.length) filesWithUnresolved++;
      }
      const byAuto = resolved - resolvedBefore;
      const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
      this.status =
        byAuto === 0
          ? 'No conflicts were resolved automatically'
          : unresolved === 0
            ? 'All conflicts were resolved automatically'
            : `${plural(byAuto, '1 conflict', `${byAuto} conflicts`)} resolved. ${plural(unresolved, '1 conflict', `${unresolved} conflicts`)} in ${plural(filesWithUnresolved, '1 file', `${filesWithUnresolved} files`)} still ${plural(unresolved, 'requires', 'require')} attention`;
    } finally {
      this.setBusy(false);
    }
  }

  // ---------------------------------------------------------------- VS Code merge editor (optional)

  /** Opens the three-pane window, or VS Code's merge editor when `ideagittool.merge.useVsCodeMergeEditor` is set. */
  async openMergeEditor(c: Change) {
    return this.show(c.root, [changeKey(c)]);
  }

  private async openVsCodeMergeEditor(c: Change) {
    const repo = this.ctx.repos.get(c.root);
    const rev = this.reversed(repo);
    const d = this.description();
    const context = this.context(repo);
    const plain = (t: TitleParts | undefined) => t?.map(p => p.text).join('');
    const file = vscode.Uri.file(path.join(c.root, c.path));
    let initial = '';
    try {
      initial = fs.readFileSync(file.fsPath, 'utf8');
    } catch {
      // Deleted on one side: there is no work tree file yet.
    }
    this.pending.set(file.fsPath, { root: c.root, path: c.path, initial });
    try {
      await vscode.commands.executeCommand('_open.mergeEditor', {
        base: toGitUri(c.root, c.path, ':1'),
        input1: { uri: toGitUri(c.root, c.path, rev ? ':3' : ':2'), title: d.yours, description: plain(context?.left) ?? 'Your version', detail: c.path },
        input2: { uri: toGitUri(c.root, c.path, rev ? ':2' : ':3'), title: d.theirs, description: plain(context?.right) ?? 'Changes from the other side', detail: c.path },
        output: file,
      });
    } catch {
      await vscode.window.showTextDocument(file);
    }
  }

  private async onMergeEditorClosed(result: vscode.Uri) {
    const p = this.pending.get(result.fsPath);
    if (!p) return;
    const stillOpen = vscode.window.tabGroups.all.some(g => g.tabs.some(t => mergeResult(t.input)?.fsPath === result.fsPath));
    if (stillOpen) return;
    this.pending.delete(result.fsPath);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === result.fsPath);
    if (doc?.isDirty) return;
    let text: string;
    try {
      text = fs.readFileSync(result.fsPath, 'utf8');
    } catch {
      return;
    }
    if (text === p.initial || /^(<{7}|>{7})( |$)/m.test(text)) return;
    const repo = this.ctx.repos.get(p.root);
    if (!repo || !repo.status.conflicts.some(c => c.path === p.path)) return;
    await repo.batch(() => addFiles(repo, [p.path], true));
    void notifySuccess('Conflict resolved', p.path, {
      label: 'Undo',
      run: () => repo.batch(() => repo.exec(['checkout', '-m', '--', p.path])),
    });
  }
}

/** Result file of a merge editor tab. The tab input type (TabInputTextMerge) is not in the minimum supported API. */
function mergeResult(input: unknown): vscode.Uri | undefined {
  const i = input as { base?: unknown; input1?: unknown; input2?: unknown; result?: unknown } | undefined;
  return i && i.base instanceof vscode.Uri && i.input1 instanceof vscode.Uri && i.result instanceof vscode.Uri ? i.result : undefined;
}
