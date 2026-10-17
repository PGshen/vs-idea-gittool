import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { openChangeDiff, REV_EMPTY, shortHash, toGitUri } from '../../host/gitContent';
import { showDialog } from '../../host/dialog';
import { ask, notifySuccess, notifyWarning, withProgress } from '../../host/ui';
import { CancelledError, showError, WebviewConnection } from '../../host/webviewHost';
import { changeKey, CommitOptionsState, CommitRepoInfo, CommitViewState, StashInfo, ViewSettings } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { ChangeLists } from './changelists';
import { ConflictsController } from './conflicts';
import {
  acceptSide,
  addFiles,
  addToGitignore,
  amendSpecificCommit,
  commitChanges,
  createPatch,
  deleteFiles,
  lastCommitMessage,
  rollbackChanges,
  stashFiles,
  StashFile,
} from './gitOps';
import { Shelf } from './shelf';

const SETTINGS_KEY = 'rebased.commitView.settings';
const OPTIONS_KEY = 'rebased.commit.options';
const HISTORY_KEY = 'rebased.commit.messageHistory';
const DRAFT_KEY = 'rebased.commit.draft';

const DEFAULT_SETTINGS: ViewSettings = { groupByDirectory: false, groupByRepository: true, showIgnored: false, doubleClick: 'diff', showRecycledShelves: false };

/**
 * The Commit tool window (IntelliJ's commit workflow in the "Commit" tool window with Commit / Shelf / Stash tabs).
 */
export class CommitView implements vscode.WebviewViewProvider {
  private conn: WebviewConnection | undefined;
  private view: vscode.WebviewView | undefined;
  readonly changelists: ChangeLists;
  readonly shelf: Shelf;
  readonly conflicts: ConflictsController;
  private changeByKey = new Map<string, Change>();
  private lastState: CommitViewState | undefined;
  private pushTimer: NodeJS.Timeout | undefined;
  /** Requested from "Commit File…": select these files once the view is ready. */
  private pendingInclude: string[] | undefined;

  constructor(private readonly ctx: Ctx) {
    const ext = ctx.extension;
    this.changelists = new ChangeLists(ext.workspaceState);
    this.shelf = new Shelf(ext.storageUri ?? ext.globalStorageUri);
    this.conflicts = new ConflictsController(ctx);
    ctx.repos.onDidChangeRepository(() => this.schedulePush());
    ctx.repos.onDidChangeRepositories(() => this.schedulePush());
    this.changelists.onDidChange(() => this.schedulePush());
    this.shelf.onDidChange(() => this.schedulePush());
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('rebased')) this.schedulePush();
    });
  }

  get settings(): ViewSettings {
    return { ...DEFAULT_SETTINGS, ...this.ctx.extension.workspaceState.get<Partial<ViewSettings>>(SETTINGS_KEY, {}) };
  }

  get options(): CommitOptionsState {
    return { author: '', signOff: false, extraMoveCommit: false, ...this.ctx.extension.workspaceState.get<Partial<CommitOptionsState>>(OPTIONS_KEY, {}) };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.conn?.dispose();
    this.conn = new WebviewConnection(view.webview, 'commit', () => ({ state: this.buildState(), draft: this.ctx.extension.workspaceState.get<string>(DRAFT_KEY, '') }), 'Commit');
    this.registerHandlers(this.conn);
    view.onDidDispose(() => {
      this.conn?.dispose();
      this.conn = undefined;
      this.view = undefined;
    });
    view.onDidChangeVisibility(() => view.visible && this.schedulePush());
  }

  post(name: string, data?: unknown) {
    this.conn?.post(name, data);
  }

  async reveal(tab?: 'commit' | 'shelf' | 'stash') {
    await vscode.commands.executeCommand('rebased.commit.focus');
    if (tab) this.conn?.post('selectTab', tab);
  }

  schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.conn?.post('state', this.buildState());
      if (this.pendingInclude && this.conn) {
        this.changelists.setIncludedExactly(this.pendingInclude);
        this.pendingInclude = undefined;
      }
    }, 50);
  }

  /** Includes exactly these files into the commit and focuses the message (Commit File…). */
  async commitFiles(keys: string[]) {
    this.changelists.setIncludedExactly(keys);
    await this.reveal('commit');
    this.conn?.post('focusMessage');
  }

  buildState(): CommitViewState {
    const repos = this.ctx.repos.repositories;
    const changes: Change[] = [];
    const unversioned: Change[] = [];
    const ignored: Change[] = [];
    const conflicts: Change[] = [];
    this.changeByKey.clear();
    for (const r of repos) {
      changes.push(...r.status.changes);
      unversioned.push(...r.status.unversioned);
      ignored.push(...r.status.ignored);
      conflicts.push(...r.status.conflicts);
    }
    for (const c of [...changes, ...unversioned, ...ignored]) this.changeByKey.set(changeKey(c), c);
    const nonConflict = changes.filter(c => c.status !== 'U');
    this.changelists.autoInclude = vscode.workspace.getConfiguration('rebased.commit').get<boolean>('includeActiveChangelist', false);
    const changelists = this.changelists.sync(nonConflict, unversioned);
    const stashes: StashInfo[] = repos.flatMap(r => r.stashes.map(s => ({ ...s, root: r.root, repoName: r.name })));
    this.lastState = {
      repos: repos.map(r => this.repoInfo(r)),
      changelists,
      unversioned,
      ignored: this.settings.showIgnored ? ignored : [],
      conflicts,
      included: this.changelists.getIncluded(),
      settings: this.settings,
      options: this.options,
      shelves: this.shelf.list(),
      stashes,
      messageHistory: this.ctx.extension.workspaceState.get<string[]>(HISTORY_KEY, []),
      loading: false,
    };
    return this.lastState;
  }

  private repoInfo(r: Repository): CommitRepoInfo {
    let target: string | undefined;
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(r.gitDir, f), 'utf8').trim();
      } catch {
        return undefined;
      }
    };
    if (r.info.operation === 'rebase') target = read('rebase-merge/onto') ?? read('rebase-apply/onto');
    else if (r.info.operation === 'merge') {
      const msg = read('MERGE_MSG');
      target = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg ?? '')?.[1] ?? read('MERGE_HEAD');
    } else if (r.info.operation === 'cherry-pick') target = read('CHERRY_PICK_HEAD');
    else if (r.info.operation === 'revert') target = read('REVERT_HEAD');
    return {
      root: r.root,
      name: r.name,
      branch: r.info.branch,
      headHash: r.info.headHash,
      operation: r.info.operation,
      rebaseHeadName: r.info.rebaseHeadName,
      operationTarget: target ? shortHash(target) : undefined,
    };
  }

  /** Changes for keys, from the last state. */
  changes(keys: string[]): Change[] {
    return keys.map(k => this.changeByKey.get(k)).filter((c): c is Change => !!c);
  }

  private byRepo(changes: Change[]): [Repository, Change[]][] {
    const map = new Map<string, Change[]>();
    for (const c of changes) {
      const list = map.get(c.root) ?? [];
      list.push(c);
      map.set(c.root, list);
    }
    return [...map].map(([root, list]) => [this.ctx.repos.get(root)!, list] as [Repository, Change[]]).filter(([r]) => !!r);
  }

  private registerHandlers(conn: WebviewConnection) {
    conn.handleAll({
      ready: () => ({ state: this.buildState(), draft: this.ctx.extension.workspaceState.get<string>(DRAFT_KEY, '') }),
      refresh: async () => {
        await this.ctx.repos.scan();
        await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
      },
      setIncluded: (p: { keys: string[]; value: boolean }) => this.changelists.setIncluded(p.keys, p.value),
      setIncludedExactly: (p: { keys: string[] }) => this.changelists.setIncludedExactly(p.keys),
      saveDraft: (p: { message: string }) => this.ctx.extension.workspaceState.update(DRAFT_KEY, p.message),
      setSettings: async (p: Partial<ViewSettings>) => {
        await this.ctx.extension.workspaceState.update(SETTINGS_KEY, { ...this.settings, ...p });
        if (p.showIgnored !== undefined) {
          await vscode.workspace.getConfiguration('rebased').update('showIgnoredFiles', p.showIgnored, vscode.ConfigurationTarget.Workspace);
        }
        this.schedulePush();
      },
      setOptions: async (p: Partial<CommitOptionsState>) => {
        await this.ctx.extension.workspaceState.update(OPTIONS_KEY, { ...this.options, ...p });
        this.schedulePush();
      },
      defaultAuthor: async () => {
        const r = this.ctx.repos.repositories[0];
        if (!r) return '';
        const name = await r.getConfig('user.name');
        const email = await r.getConfig('user.email');
        return name ? `${name} <${email ?? ''}>` : '';
      },
      showDiff: (p: { keys: string[] }) => this.showDiff(p.keys),
      openSource: (p: { keys: string[] }) => this.openSource(p.keys),
      commit: (p: { message: string; amend: boolean; amendHash?: string; push: boolean; keys: string[] }) => this.commit(p),
      amendMessage: async (p: { root?: string; hash?: string }) => {
        const repo = p.root ? this.ctx.repos.get(p.root) : this.ctx.repos.repositories[0];
        return repo ? lastCommitMessage(repo, p.hash ?? 'HEAD') : '';
      },
      amendCandidates: async () => {
        const repo = this.ctx.repos.repositories[0];
        if (!repo || repo.info.empty) return [];
        const out = await repo.execText(['log', '-10', '--format=%H%x00%s%x00%an%x00%at'], { quiet: true });
        return out
          .split('\n')
          .filter(Boolean)
          .map(l => {
            const [hash, subject, author, date] = l.split('\0');
            return { hash, subject, author, date: +date, root: repo.root };
          });
      },
      rollback: (p: { keys: string[] }) => this.rollbackDialog(p.keys),
      deleteFiles: (p: { keys: string[] }) => this.deleteFiles(p.keys),
      addToVcs: async (p: { keys: string[] }) => {
        for (const [repo, list] of this.byRepo(this.changes(p.keys))) await repo.batch(() => addFiles(repo, list.map(c => c.path), true));
      },
      ignore: (p: { keys: string[] }) => this.ignore(p.keys),
      moveToChangelist: (p: { keys: string[]; listId?: string }) => this.moveToChangelist(p.keys, p.listId),
      newChangelist: (p: { keys?: string[] }) => this.newChangelist(p.keys),
      editChangelist: (p: { id: string }) => this.editChangelist(p.id),
      removeChangelist: (p: { id: string }) => this.removeChangelist(p.id),
      setActiveChangelist: (p: { id: string }) => this.changelists.setActive(p.id),
      shelve: (p: { keys: string[] }) => this.shelveDialog(p.keys),
      shelveSilently: (p: { keys: string[] }) => this.shelveSilently(p.keys),
      createPatch: (p: { keys: string[] }) => this.createPatchFile(this.changes(p.keys)),
      copyPatch: (p: { keys: string[] }) => this.copyPatch(this.changes(p.keys)),
      copyPath: (p: { keys: string[]; kind: 'absolute' | 'name' | 'repo' }) => this.copyPath(p.keys, p.kind),
      showHistory: (p: { key: string }) => {
        const c = this.changeByKey.get(p.key);
        if (c) return vscode.commands.executeCommand('rebased.showFileHistory', { root: c.root, path: c.path });
      },
      annotate: (p: { key: string }) => {
        const c = this.changeByKey.get(p.key);
        if (c) return vscode.commands.executeCommand('rebased.annotate', vscode.Uri.file(path.join(c.root, c.path)));
      },
      resolveConflicts: (p: { root?: string }) => this.conflicts.show(p.root),
      acceptYours: (p: { keys: string[] }) => this.accept(p.keys, true),
      acceptTheirs: (p: { keys: string[] }) => this.accept(p.keys, false),
      mergeConflict: (p: { key: string }) => {
        const c = this.lastState?.conflicts.find(x => changeKey(x) === p.key);
        if (c) return this.conflicts.openMergeEditor(c);
      },
      operation: (p: { action: 'continue' | 'abort' | 'skip'; root: string }) =>
        vscode.commands.executeCommand(p.action === 'continue' ? 'rebased.continueOperation' : p.action === 'abort' ? 'rebased.abortOperation' : 'rebased.skipCommit', { root: p.root }),
      gitCommand: (p: { command: string; args?: { $uri?: string } }) =>
        vscode.commands.executeCommand(p.command, p.args?.$uri ? vscode.Uri.file(p.args.$uri) : p.args),
      activeFileKey: () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file') return undefined;
        const repo = this.ctx.repos.getForFile(uri.fsPath);
        return repo ? changeKey({ root: repo.root, path: repo.relPath(uri.fsPath) }) : undefined;
      },

      // Shelf
      unshelve: (p: { id: string; paths?: string[] }) => this.unshelveDialog(p.id, p.paths),
      unshelveSilently: (p: { ids: string[]; paths?: string[] }) => this.unshelveSilently(p.ids, p.paths),
      shelfDiff: (p: { id: string; path: string }) => this.shelfDiff(p.id, p.path, false),
      shelfCompareWithLocal: (p: { id: string; path: string }) => this.shelfDiff(p.id, p.path, true),
      renameShelf: async (p: { id: string }) => {
        const s = this.shelf.get(p.id);
        if (!s) return;
        const name = await vscode.window.showInputBox({ title: 'Rename Shelved Changelist', prompt: 'New name:', value: s.name, ignoreFocusOut: true });
        if (name?.trim()) this.shelf.rename(p.id, name.trim());
      },
      deleteShelves: (p: { ids: string[] }) => this.deleteShelves(p.ids),
      deleteShelfFiles: (p: { id: string; paths: string[] }) => this.shelf.deleteFiles(p.id, p.paths),
      restoreShelves: (p: { ids: string[] }) => this.shelf.restore(p.ids),
      cleanShelves: async () => {
        const a = await ask('Delete all already unshelved changelists?', 'Applied shelved changes in "Recently Deleted" are removed permanently.', 'Delete');
        if (a) this.shelf.cleanDeleted();
      },
      shelfCreatePatch: (p: { id: string; paths?: string[] }) => this.savePatchText(this.shelf.patchFor(p.id, p.paths), this.shelf.get(p.id)?.name),
      shelfCopyPatch: async (p: { id: string; paths?: string[] }) => {
        await vscode.env.clipboard.writeText(this.shelf.patchFor(p.id, p.paths));
        void notifySuccess('Patch copied to clipboard');
      },
      importPatches: () => this.importPatches(),

      // Stash
      stashFiles: async (p: { root: string; hash: string }) => {
        const repo = this.ctx.repos.get(p.root);
        return repo ? stashFiles(repo, p.hash) : [];
      },
      stashDiff: (p: { file: StashFile; withLocal?: 'after' | 'before' }) => this.stashDiff(p.file, p.withLocal),
      stashApply: (p: { root: string; ref: string; pop: boolean; index?: boolean }) => this.stashApply(p.root, p.ref, p.pop, !!p.index),
      stashDrop: (p: { root: string; ref: string; message: string }) => this.stashDrop(p.root, p.ref, p.message),
      stashClear: (p: { root: string }) => this.stashClear(p.root),
      unstashAs: (p: { root: string; ref: string }) => vscode.commands.executeCommand('rebased.unstash', { root: p.root, ref: p.ref }),
      stashChanges: () => vscode.commands.executeCommand('rebased.stash'),
    });
  }

  async showDiff(keys: string[]) {
    const changes = this.changes(keys);
    if (!changes.length) return;
    if (changes.length > 1) {
      await vscode.commands.executeCommand(
        'vscode.changes',
        'Local Changes',
        changes.map(c => {
          const left = c.status === 'A' || c.status === '?' ? undefined : toGitUri(c.root, c.oldPath ?? c.path, c.status === 'U' ? ':2' : 'HEAD');
          const right = c.status === 'D' ? undefined : vscode.Uri.file(path.join(c.root, c.path));
          return [vscode.Uri.file(path.join(c.root, c.path)), left, right];
        }),
      );
      return;
    }
    const c = changes[0];
    const repo = this.ctx.repos.get(c.root);
    const left = repo?.info.empty ? REV_EMPTY : 'HEAD';
    await openChangeDiff(c, left, 'WORKTREE');
  }

  async openSource(keys: string[]) {
    for (const c of this.changes(keys)) {
      if (c.status === 'D') continue;
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(c.root, c.path)), { preview: keys.length === 1 });
    }
  }

  async commit(p: { message: string; amend: boolean; amendHash?: string; push: boolean; keys: string[] }): Promise<{ ok: boolean; error?: string }> {
    const message = p.message.replace(/\s+$/, '');
    const included = this.changes(p.keys);
    if (!message.trim() && !included.length && !p.amend) return { ok: false, error: 'Select files to commit and specify commit message' };
    if (!included.length && !p.amend) return { ok: false, error: 'Select files to commit' };
    if (!message.trim()) return { ok: false, error: 'Specify commit message' };
    const conflicted = included.filter(c => c.status === 'U');
    if (conflicted.length) {
      const a = await ask('Commit with unresolved conflicts?', `${conflicted.length} file(s) have unresolved merge conflicts.`, 'Resolve…', 'Commit Anyway');
      if (a === 'Resolve…') {
        await this.conflicts.show();
        return { ok: false };
      }
      if (!a) return { ok: false };
    }
    const o = this.options;
    const cfg = vscode.workspace.getConfiguration('rebased.commit');
    const opts = {
      amend: p.amend,
      author: o.author || undefined,
      signOff: o.signOff,
      extraMoveCommit: o.extraMoveCommit,
      gpgSign: cfg.get<boolean>('gpgSign', false),
      runHooks: !cfg.get<boolean>('skipHooks', false),
    };
    const groups = this.byRepo(included);
    if (!groups.length && p.amend) {
      const repo = this.ctx.repos.repositories[0];
      if (repo) groups.push([repo, []]);
    }
    const committed: Repository[] = [];
    try {
      await withProgress(
        'Committing…',
        async () => {
          for (const [repo, list] of groups) {
            await repo.batch(async () => {
              if (p.amend && p.amendHash && repo.info.headHash !== p.amendHash) await amendSpecificCommit(repo, p.amendHash, list, message, opts);
              else await commitChanges(repo, list, message, opts);
            });
            committed.push(repo);
          }
        },
        { location: 'window' },
      );
    } catch (e) {
      showError(e, 'Commit failed');
      return { ok: false };
    }
    await this.rememberMessage(message);
    await this.ctx.extension.workspaceState.update(DRAFT_KEY, '');
    const n = included.length;
    const subject = message.split('\n')[0];
    void notifySuccess(`${n === 0 ? 'No files' : n === 1 ? '1 file' : `${n} files`} committed`, subject);
    if (p.push) {
      for (const repo of committed) await vscode.commands.executeCommand('rebased.push', { root: repo.root });
    }
    return { ok: true };
  }

  private async rememberMessage(message: string) {
    const list = this.ctx.extension.workspaceState.get<string[]>(HISTORY_KEY, []).filter(m => m !== message);
    list.unshift(message);
    await this.ctx.extension.workspaceState.update(HISTORY_KEY, list.slice(0, 25));
  }

  async rollbackDialog(keys: string[], all = false) {
    const st = this.lastState ?? this.buildState();
    const files = [...st.changelists.flatMap(l => l.changes), ...st.conflicts];
    const selected = all || !keys.length ? files.map(changeKey) : keys.filter(k => files.some(f => changeKey(f) === k));
    if (!files.length) {
      void vscode.window.showInformationMessage('No changes to roll back');
      return;
    }
    const res = await showDialog<{ keys: string[]; deleteAdded: boolean }>(
      'commit.rollback',
      { files, selected, groupByDirectory: this.settings.groupByDirectory },
      { title: 'Rollback Changes' },
    );
    if (!res || !res.keys.length) return;
    for (const [repo, list] of this.byRepo(this.changes(res.keys))) {
      await repo.batch(() => rollbackChanges(repo, list, res.deleteAdded));
    }
  }

  async deleteFiles(keys: string[]) {
    const changes = this.changes(keys).filter(c => c.status !== 'D');
    if (!changes.length) return;
    const a = await ask(changes.length === 1 ? `Delete "${path.basename(changes[0].path)}"?` : `Delete ${changes.length} files?`, undefined, 'Delete');
    if (!a) return;
    for (const c of changes) await vscode.workspace.fs.delete(vscode.Uri.file(path.join(c.root, c.path)), { useTrash: true, recursive: true });
  }

  async ignore(keys: string[]) {
    for (const [repo, list] of this.byRepo(this.changes(keys))) addToGitignore(repo, list.map(c => c.path));
  }

  async moveToChangelist(keys: string[], listId?: string) {
    if (!listId) {
      const items: (vscode.QuickPickItem & { id?: string })[] = this.changelists.all().map(l => ({ label: l.name, description: l.id === this.changelists.active.id ? 'active' : undefined, id: l.id }));
      items.push({ label: '$(add) New Changelist…' });
      const pick = await vscode.window.showQuickPick(items, { title: 'Move to Another Changelist', placeHolder: 'Choose changelist' });
      if (!pick) return;
      listId = pick.id ?? (await this.newChangelist());
      if (!listId) return;
    }
    this.changelists.move(keys, listId);
  }

  async newChangelist(keys?: string[]): Promise<string | undefined> {
    const res = await showDialog<{ name: string; comment: string; makeActive: boolean }>(
      'commit.changelist',
      { mode: 'new', name: '', comment: '', makeActive: false, existing: this.changelists.all().map(l => l.name) },
      { title: 'New Changelist' },
    );
    if (!res) return undefined;
    const id = this.changelists.add(res.name, res.comment, res.makeActive);
    if (keys?.length) this.changelists.move(keys, id);
    return id;
  }

  async editChangelist(id: string) {
    const l = this.changelists.all().find(x => x.id === id);
    if (!l) return;
    const res = await showDialog<{ name: string; comment: string; makeActive: boolean }>(
      'commit.changelist',
      { mode: 'edit', name: l.name, comment: l.comment ?? '', makeActive: this.changelists.active.id === id, existing: this.changelists.all().filter(x => x.id !== id).map(x => x.name) },
      { title: 'Edit Changelist' },
    );
    if (!res) return;
    this.changelists.edit(id, res.name, res.comment);
    if (res.makeActive) this.changelists.setActive(id);
  }

  async removeChangelist(id: string) {
    const l = this.changelists.all().find(x => x.id === id);
    if (!l || this.changelists.all().length <= 1) return;
    const hasFiles = this.lastState?.changelists.find(x => x.id === id)?.changes.length;
    if (hasFiles) {
      const a = await ask(`Delete changelist "${l.name}"?`, 'Its changes will be moved to the active changelist.', 'Delete');
      if (!a) return;
    }
    this.changelists.remove(id);
  }

  async shelveDialog(keys: string[]) {
    const st = this.lastState ?? this.buildState();
    const files = [...st.changelists.flatMap(l => l.changes), ...st.unversioned];
    if (!files.length) {
      void vscode.window.showInformationMessage('No changes to shelve');
      return;
    }
    const selected = keys.length ? keys : st.included;
    const active = st.changelists.find(l => l.isDefault);
    const res = await showDialog<{ keys: string[]; name: string }>(
      'commit.shelve',
      { files, selected, name: active && active.name !== 'Changes' ? active.name : '', groupByDirectory: this.settings.groupByDirectory },
      { title: 'Shelve Changes', validate: v => (v.keys.length ? undefined : 'Select files to shelve') },
    );
    if (!res) return;
    await this.doShelve(this.changes(res.keys), res.name);
  }

  async shelveSilently(keys: string[]) {
    const st = this.lastState ?? this.buildState();
    let changes = this.changes(keys);
    if (!changes.length) changes = this.changes(st.included);
    if (!changes.length) return;
    const list = st.changelists.find(l => l.changes.some(c => changes.includes(c)));
    await this.doShelve(changes, list?.name ?? 'Changes');
  }

  private async doShelve(changes: Change[], name: string) {
    await withProgress(
      'Shelving changes…',
      async () => {
        for (const [repo, list] of this.byRepo(changes)) await this.shelf.shelve(repo, list, name || 'Shelved changes');
      },
      { location: 'window' },
    );
    void notifySuccess('Changes shelved successfully', undefined, { label: 'Show Shelf', run: () => this.reveal('shelf') });
  }

  async unshelveDialog(id: string, paths?: string[]) {
    const s = this.shelf.list().find(x => x.id === id);
    if (!s) return;
    const res = await showDialog<{ paths: string[]; changelist: string; removeApplied: boolean }>(
      'commit.unshelve',
      { shelf: s, selected: paths ?? s.files.map(f => f.path), changelists: this.changelists.all().map(l => l.name), changelist: s.name },
      { title: 'Unshelve Changes' },
    );
    if (!res || !res.paths.length) return;
    await this.doUnshelve(id, res.paths, res.removeApplied, res.changelist);
  }

  async unshelveSilently(ids: string[], paths?: string[]) {
    for (const id of ids) await this.doUnshelve(id, paths, true, undefined);
  }

  private async doUnshelve(id: string, paths: string[] | undefined, removeApplied: boolean, changelist: string | undefined) {
    const s = this.shelf.get(id);
    if (!s) return;
    const repo = this.ctx.repos.get(s.root) ?? (await this.ctx.repos.open(s.root));
    if (!repo) throw new Error(`Repository ${s.root} is not available`);
    const files = s.files.filter(f => !paths || paths.includes(f.path));
    const { conflicts } = await withProgress('Unshelving changes…', () => this.shelf.unshelve(repo, id, paths, removeApplied), { location: 'window' });
    if (changelist && changelist !== this.changelists.active.name) {
      const listId = this.changelists.findByName(changelist)?.id ?? this.changelists.add(changelist);
      this.changelists.move(
        files.map(f => changeKey({ root: s.root, path: f.path })),
        listId,
      );
    }
    if (conflicts) {
      void notifyWarning('Unshelved with conflicts', 'Some files could not be applied cleanly', { label: 'Resolve Conflicts…', run: () => this.conflicts.show(repo.root) });
    }
  }

  async deleteShelves(ids: string[]) {
    const items = ids.map(id => this.shelf.get(id)).filter(Boolean);
    if (!items.length) return;
    const permanent = items.every(s => s!.deleted);
    if (permanent) {
      const a = await ask(items.length === 1 ? `Delete the '${items[0]!.name}' changelist permanently?` : `Delete ${items.length} changelists permanently?`, undefined, 'Delete');
      if (!a) return;
    }
    this.shelf.delete(ids);
    if (!permanent) {
      void notifySuccess(`${items.length === 1 ? `the '${items[0]!.name}' changelist` : `${items.length} changelists`} deleted from shelf successfully`, undefined, {
        label: 'Undo Shelf Deletion',
        run: () => this.shelf.restore(ids),
      });
    }
  }

  async shelfDiff(id: string, file: string, withLocal: boolean) {
    const s = this.shelf.get(id);
    const f = s?.files.find(x => x.path === file);
    if (!s || !f) return;
    const repo = this.ctx.repos.get(s.root);
    const exists = async (blob?: string) => !blob || !repo || (await repo.exec(['cat-file', '-e', blob], { allowFailure: true, quiet: true })).exitCode === 0;
    const name = path.posix.basename(f.path);
    if (!(await exists(f.oldBlob)) || !(await exists(f.newBlob))) {
      // Objects were garbage collected: show the patch instead.
      const doc = await vscode.workspace.openTextDocument({ content: this.shelf.patchFor(id, [file]), language: 'diff' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    const shelved = f.newBlob ? toGitUri(s.root, f.path, `blob:${f.newBlob}`) : toGitUri(s.root, f.path, REV_EMPTY);
    if (withLocal) {
      await vscode.commands.executeCommand('vscode.diff', shelved, vscode.Uri.file(path.join(s.root, f.path)), `${name} (Shelved version ↔ Local)`);
      return;
    }
    const base = f.oldBlob ? toGitUri(s.root, f.oldPath ?? f.path, `blob:${f.oldBlob}`) : toGitUri(s.root, f.path, REV_EMPTY);
    await vscode.commands.executeCommand('vscode.diff', base, shelved, `Shelved: ${s.name} — ${name}`, { preview: true });
  }

  async stashDiff(f: StashFile, withLocal?: 'after' | 'before') {
    const name = path.posix.basename(f.path);
    const right = f.status === 'D' ? toGitUri(f.root, f.path, REV_EMPTY) : toGitUri(f.root, f.path, f.right);
    const left = !f.left || f.status === 'A' ? toGitUri(f.root, f.path, REV_EMPTY) : toGitUri(f.root, f.oldPath ?? f.path, f.left);
    const local = vscode.Uri.file(path.join(f.root, f.path));
    if (withLocal === 'after') await vscode.commands.executeCommand('vscode.diff', right, local, `${name} (Stash ↔ Local)`);
    else if (withLocal === 'before') await vscode.commands.executeCommand('vscode.diff', left, local, `${name} (Before stash ↔ Local)`);
    else await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${shortHash(f.left.replace(/\^\d$/, ''))} ↔ stash)`, { preview: true });
  }

  async stashApply(root: string, ref: string, pop: boolean, index: boolean) {
    const repo = this.ctx.repos.get(root);
    if (!repo) return;
    const args = ['stash', pop ? 'pop' : 'apply', ...(index ? ['--index'] : []), ref];
    const r = await withProgress('Unstashing…', () => repo.batch(() => repo.exec(args, { allowFailure: true })), { location: 'window' });
    if (r.exitCode !== 0) {
      if (/conflict/i.test(r.stdout + r.stderr)) {
        void notifyWarning('Unstashed with conflicts', undefined, { label: 'Resolve conflicts…', run: () => this.conflicts.show(root) });
      } else showError(new Error(r.stderr.trim() || r.stdout.trim()), 'Unstash failed');
      return;
    }
    void notifySuccess('Stash successfully applied');
  }

  async stashDrop(root: string, ref: string, message: string) {
    const repo = this.ctx.repos.get(root);
    if (!repo) return;
    const a = await ask(`Remove Stash ${ref}?`, `Do you want to remove ${ref}?\n"${message}"`, 'Remove');
    if (!a) return;
    await repo.batch(() => repo.exec(['stash', 'drop', ref]));
  }

  async stashClear(root: string) {
    const repo = this.ctx.repos.get(root);
    if (!repo) return;
    const a = await ask('Remove All Stashes?', 'Remove all stashes? This cannot be undone.', 'Remove');
    if (!a) return;
    await repo.batch(() => repo.exec(['stash', 'clear']));
  }

  async accept(keys: string[], yours: boolean) {
    const conflicts = (this.lastState?.conflicts ?? []).filter(c => keys.includes(changeKey(c)));
    for (const [repo, list] of this.byRepo(conflicts)) {
      const reversed = repo.info.operation === 'rebase';
      const side = yours !== reversed ? 'ours' : 'theirs';
      await repo.batch(() => acceptSide(repo, list, side));
    }
  }

  async copyPatch(changes: Change[]) {
    if (!changes.length) return;
    let text = '';
    for (const [repo, list] of this.byRepo(changes)) text += (await createPatch(repo, list)).patch;
    await vscode.env.clipboard.writeText(text);
    void notifySuccess('Patch copied to clipboard');
  }

  async createPatchFile(changes: Change[]) {
    if (!changes.length) return;
    let text = '';
    for (const [repo, list] of this.byRepo(changes)) text += (await createPatch(repo, list)).patch;
    await this.savePatchText(text, 'Local_Changes');
  }

  private async savePatchText(text: string, name = 'changes') {
    const root = this.ctx.repos.repositories[0]?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const uri = await vscode.window.showSaveDialog({
      title: 'Create Patch',
      defaultUri: vscode.Uri.file(path.join(root, `${name.replace(/[^\w.-]+/g, '_')}.patch`)),
      filters: { Patch: ['patch', 'diff'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
    void notifySuccess('Patch file created', path.basename(uri.fsPath), { label: 'Open', run: () => vscode.window.showTextDocument(uri) });
  }

  async importPatches() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, title: 'Import Patches', filters: { Patch: ['patch', 'diff'] } });
    if (!uris?.length) return;
    const repo = await this.ctx.repos.pick();
    if (!repo) return;
    for (const u of uris) this.shelf.importPatch(repo.root, path.basename(u.fsPath).replace(/\.(patch|diff)$/, ''), Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8'));
  }

  async copyPath(keys: string[], kind: 'absolute' | 'name' | 'repo') {
    const text = this.changes(keys)
      .map(c => (kind === 'absolute' ? path.join(c.root, c.path) : kind === 'name' ? path.posix.basename(c.path) : c.path))
      .join('\n');
    await vscode.env.clipboard.writeText(text);
  }
}

