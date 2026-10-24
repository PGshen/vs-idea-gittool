import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { withProgress } from '../../host/ui';
import { showError } from '../../host/webviewHost';
import { repoFor, RootArg } from './common';
import { createWorktree, listWorktrees, removeWorktree, samePath, Worktree } from './engine';
import { ijIcon } from './icons';

// Git worktrees: the "Worktrees" tab of the Git tool window (GitWorktreesTabPanel), New Worktree dialog
// (GitWorkingTreeDialog) and the worktree actions of the branches popup.

type Node = { kind: 'repo'; repo: Repository } | { kind: 'worktree'; repo: Repository; wt: Worktree };

export interface WorktreeArg extends RootArg {
  path?: string;
}

/** Tree view "Worktrees" (Git.WorkingTrees.ToolwindowGroup). */
export class WorktreesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private cache = new Map<string, Worktree[]>();
  readonly view: vscode.TreeView<Node>;

  constructor(private readonly ctx: Ctx) {
    this.view = vscode.window.createTreeView('ideagittool.worktrees', { treeDataProvider: this, showCollapseAll: false, canSelectMany: false });
    this.disposables.push(this.view);
    ctx.repos.onDidChangeRepository(e => e.refs && this.refresh(), null, this.disposables);
    ctx.repos.onDidChangeRepositories(() => this.refresh(), null, this.disposables);
  }

  refresh() {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  /** Selected worktree, for toolbar actions. */
  selected(): { repo: Repository; wt: Worktree } | undefined {
    const n = this.view.selection[0];
    return n?.kind === 'worktree' ? { repo: n.repo, wt: n.wt } : undefined;
  }

  private async worktrees(repo: Repository) {
    let list = this.cache.get(repo.root);
    if (!list) {
      list = await listWorktrees(repo);
      this.cache.set(repo.root, list);
    }
    return list;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    await this.ctx.repos.ready();
    const repos = this.ctx.repos.repositories;
    if (!node) {
      if (repos.length > 1) return repos.map(repo => ({ kind: 'repo', repo }));
      if (repos.length === 0) return [];
      node = { kind: 'repo', repo: repos[0] };
    }
    if (node.kind !== 'repo') return [];
    const list = await this.worktrees(node.repo);
    // IntelliJ shows "No linked worktrees" when only the main worktree exists.
    const linked = list.filter(w => !w.main);
    void vscode.commands.executeCommand('setContext', 'ideagittool.hasLinkedWorktrees', linked.length > 0 || repos.length > 1);
    if (linked.length === 0 && repos.length <= 1) return [];
    return list.map(wt => ({ kind: 'worktree', repo: node!.repo, wt }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = ijIcon('nodes/folder');
      item.description = node.repo.root;
      item.contextValue = 'repository';
      return item;
    }
    const { wt, repo } = node;
    const current = samePath(wt.path, repo.root);
    const item = new vscode.TreeItem(path.basename(wt.path));
    item.description = wt.branch ?? (wt.bare ? vscode.l10n.t('bare') : vscode.l10n.t('<detached>'));
    item.iconPath = current ? ijIcon('actions/checked') : wt.locked ? ijIcon('nodes/locked') : ijIcon('general/vcs');
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${path.basename(wt.path)}** — ${wt.main ? vscode.l10n.t('Main worktree') : vscode.l10n.t('Linked worktree')}\n\n`);
    tip.appendText(`${wt.path}\n`);
    tip.appendMarkdown(`\n$(git-branch) ${wt.branch ?? vscode.l10n.t('<detached>')}`);
    if (wt.locked) tip.appendMarkdown(`\n\n${wt.lockReason ? vscode.l10n.t('Locked: {0}', wt.lockReason) : vscode.l10n.t('Locked')}`);
    if (wt.prunable) tip.appendMarkdown(`\n\n${wt.prunableReason ? vscode.l10n.t('Prunable: {0}', wt.prunableReason) : vscode.l10n.t('Prunable')}`);
    tip.supportThemeIcons = true;
    item.tooltip = tip;
    item.contextValue = ['worktree', wt.main ? 'main' : 'linked', wt.locked ? 'locked' : 'unlocked', current ? 'current' : ''].join(' ');
    item.command = { command: 'ideagittool.worktrees.open', title: vscode.l10n.t('Open Worktree'), arguments: [{ root: repo.root, path: wt.path }] };
    if (wt.prunable) item.label = { label: path.basename(wt.path), highlights: [] };
    return item;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

function suggestName(repo: Repository, branch: string) {
  return `${repo.name}-${branch.replace(/^.*\//, '').replace(/[^A-Za-z0-9 _.-]/g, '-')}`;
}

/** `ideagittool.worktrees.create {root?, ref?}`: New Worktree… dialog. */
export async function createWorktreeCommand(ctx: Ctx, arg?: RootArg & { ref?: string }, view?: WorktreesView) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  if (!repos.length) throw new Error(vscode.l10n.t('No Git repository found in the workspace.'));
  const data = await Promise.all(
    repos.map(async repo => {
      const wts = await listWorktrees(repo);
      return {
        root: repo.root,
        name: repo.name,
        current: repo.info.branch,
        refs: repo.refs
          .filter(r => r.type !== 'tag')
          .map(r => ({ name: r.name, type: r.type, worktree: r.type === 'local' ? wts.find(w => w.branch === r.name)?.path : undefined })),
        tags: repo.refs.filter(r => r.type === 'tag').map(r => r.name),
      };
    }),
  );
  const initialRoot = arg?.root ?? ctx.repos.getForFile(vscode.window.activeTextEditor?.document.uri.fsPath ?? '')?.root ?? repos[0].root;
  const initialRepo = ctx.repos.get(initialRoot) ?? repos[0];
  const ref = arg?.ref ?? initialRepo.info.branch ?? '';
  type Res = { root: string; ref: string; newBranch?: string; name: string; parent: string; force?: boolean };
  const res = await showDialog<Res>(
    'ops.newWorktree',
    { repos: data, root: initialRepo.root, ref, parent: path.dirname(initialRepo.root), suggestions: Object.fromEntries(repos.map(r => [r.root, r.name])) },
    {
      title: vscode.l10n.t('New Worktree'),
      handlers: {
        browse: async (p: { current: string }) => {
          const r = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: p.current ? vscode.Uri.file(p.current) : undefined, title: vscode.l10n.t('Worktree Location') });
          return r?.[0]?.fsPath ?? null;
        },
        suggestName: (p: { root: string; ref: string }) => suggestName(ctx.repos.get(p.root)!, p.ref),
      },
      validate: (v: Res) => validateWorktree(ctx, v),
    },
  );
  if (!res) return;
  const repo = ctx.repos.get(res.root)!;
  const target = path.join(res.parent, res.name);
  const outcome = await withProgress(vscode.l10n.t('Creating worktree'), progress => createWorktree(repo, { path: target, ref: res.ref, newBranch: res.newBranch || undefined, force: res.force }, { progress }));
  await repo.refresh();
  view?.refresh();
  if (outcome.kind !== 'success') {
    showError(outcome.kind === 'error' ? outcome.error : outcome.output, vscode.l10n.t('Worktree creation failed'));
    return;
  }
  await openWorktree(target);
}

function validateWorktree(ctx: Ctx, v: { root: string; ref: string; newBranch?: string; name: string; parent: string; force?: boolean }): string | true {
  const repo = ctx.repos.get(v.root);
  if (!repo) return vscode.l10n.t('Select a repository');
  if (!v.ref) return vscode.l10n.t('Select a branch to create the worktree');
  if (v.newBranch !== undefined) {
    if (!v.newBranch.trim()) return vscode.l10n.t('A name for the branch in the worktree must be provided explicitly');
    if (repo.refs.some(r => r.type === 'local' && r.name === v.newBranch)) return vscode.l10n.t('Local branch {0} already exists', v.newBranch);
  } else {
    const remote = repo.refs.find(r => r.type === 'remote' && r.name === v.ref);
    if (remote && !repo.refs.some(r => r.type === 'local' && r.name === v.ref)) {
      const local = v.ref.slice((remote.remote?.length ?? 0) + 1);
      if (local === v.ref) return vscode.l10n.t('A name for the branch in the worktree must be provided explicitly');
      if (repo.refs.some(r => r.type === 'local' && r.name === local)) return vscode.l10n.t('Local branch {0} already exists, provide explicit name for the branch in the worktree', v.ref);
    }
  }
  if (!/^[A-Za-z0-9 _.-]+$/.test(v.name)) return vscode.l10n.t("Name should contain only letters, digits, spaces, '_', '-', '.' characters");
  if (!v.parent.trim()) return vscode.l10n.t('Provide a location for the worktree');
  if (fs.existsSync(v.parent) && !fs.statSync(v.parent).isDirectory()) return vscode.l10n.t("'{0}' is not a directory", v.parent);
  const target = path.join(v.parent, v.name);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) return vscode.l10n.t("'{0}' is a file", target);
    if (fs.readdirSync(target).length) return vscode.l10n.t("'{0}' is not empty", target);
  }
  return true;
}

export async function openWorktree(wtPath: string) {
  if (!fs.existsSync(wtPath)) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Worktree directory `{0}` no longer exists', wtPath));
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), { forceNewWindow: true });
}

async function resolve(ctx: Ctx, view: WorktreesView, arg?: WorktreeArg): Promise<{ repo: Repository; wt: Worktree } | undefined> {
  if (arg?.path) {
    const repo = await repoFor(ctx, arg);
    const wt = (await listWorktrees(repo)).find(w => samePath(w.path, arg.path!));
    return wt ? { repo, wt } : undefined;
  }
  // Tree item context menus pass the node.
  const node = arg as unknown as Node | undefined;
  if (node && (node as { kind?: string }).kind === 'worktree') return { repo: (node as { repo: Repository }).repo, wt: (node as { wt: Worktree }).wt };
  return view.selected() ?? (await pickWorktree(ctx));
}

async function pickWorktree(ctx: Ctx, title = vscode.l10n.t('Choose Worktree to Open'), filter?: (w: Worktree) => boolean) {
  const repo = await repoFor(ctx);
  const list = (await listWorktrees(repo)).filter(w => !w.main && (!filter || filter(w)));
  if (!list.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No linked worktrees'));
    return undefined;
  }
  const p = await vscode.window.showQuickPick(
    list.map(wt => ({ label: path.basename(wt.path), description: wt.branch ?? vscode.l10n.t('<detached>'), detail: wt.path, wt })),
    { title },
  );
  return p ? { repo, wt: p.wt } : undefined;
}

export async function deleteWorktreeCommand(ctx: Ctx, view: WorktreesView, arg?: WorktreeArg) {
  const sel = await resolve(ctx, view, arg);
  if (!sel) return;
  const { repo, wt } = sel;
  if (wt.main) throw new Error(vscode.l10n.t('The main worktree cannot be deleted'));
  const current = vscode.workspace.workspaceFolders?.some(f => samePath(f.uri.fsPath, wt.path));
  const a = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete Worktree'),
    { modal: true, detail: current ? vscode.l10n.t('Delete worktree {0}?\nThe project will be closed.', wt.path) : vscode.l10n.t('Delete worktree at `{0}`?', wt.path) },
    current ? vscode.l10n.t('Close and Delete') : vscode.l10n.t('Delete Worktree'),
  );
  if (!a) return;
  let outcome = await withProgress(vscode.l10n.t('Deleting worktree…'), () => removeWorktree(repo, wt.path), { location: 'window' });
  if (outcome.kind !== 'success' && /contains modified or untracked files|is locked/.test(outcome.output)) {
    const force = await vscode.window.showWarningMessage(
      vscode.l10n.t('Worktree deletion failed'),
      { modal: true, detail: `${outcome.output}\n\n${vscode.l10n.t('Delete the worktree anyway? Local changes in it will be lost.')}` },
      vscode.l10n.t('Delete Worktree'),
    );
    if (force) outcome = await withProgress(vscode.l10n.t('Deleting worktree…'), () => removeWorktree(repo, wt.path, true), { location: 'window' });
  }
  await repo.refresh();
  view.refresh();
  if (outcome.kind === 'success') {
    void vscode.window.showInformationMessage(vscode.l10n.t('Successfully deleted worktree `{0}`', wt.path));
    if (current) await vscode.commands.executeCommand('workbench.action.closeFolder');
  } else showError(outcome.kind === 'error' ? outcome.error : outcome.output, vscode.l10n.t('Worktree deletion failed'));
}

export async function pruneWorktreesCommand(ctx: Ctx, view: WorktreesView, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const prunable = await withProgress(vscode.l10n.t('Getting prunable worktrees…'), () => listWorktrees(repo), { location: 'window' }).then(l => l.filter(w => w.prunable));
  if (!prunable.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No worktrees to prune'));
    return;
  }
  const a = await vscode.window.showWarningMessage(
    vscode.l10n.t('Prune Worktrees'),
    { modal: true, detail: vscode.l10n.t('Remove Git records for missing worktrees: {0}?', `\`${prunable.map(w => w.path).join('`, `')}\``) },
    vscode.l10n.t('Prune Worktrees'),
  );
  if (!a) return;
  const r = await withProgress(vscode.l10n.t('Pruning worktrees…'), () => repo.exec(['worktree', 'prune'], { allowFailure: true }), { location: 'window' });
  view.refresh();
  if (r.exitCode === 0) void vscode.window.showInformationMessage(vscode.l10n.t('Successfully pruned worktrees'));
  else showError(r.stderr, vscode.l10n.t('Failed to prune worktrees'));
}

export async function toggleLockCommand(ctx: Ctx, view: WorktreesView, arg?: WorktreeArg, lock?: boolean) {
  const sel = await resolve(ctx, view, arg);
  if (!sel) return;
  const { repo, wt } = sel;
  const doLock = lock ?? !wt.locked;
  const r = await withProgress(doLock ? vscode.l10n.t('Locking worktree…') : vscode.l10n.t('Unlocking worktree…'), () => repo.exec(['worktree', doLock ? 'lock' : 'unlock', wt.path], { allowFailure: true }), {
    location: 'window',
  });
  view.refresh();
  if (r.exitCode === 0) void vscode.window.showInformationMessage(doLock ? vscode.l10n.t('Successfully locked worktree `{0}`', wt.path) : vscode.l10n.t('Successfully unlocked worktree `{0}`', wt.path));
  else showError(r.stderr, doLock ? vscode.l10n.t('Failed to lock worktree') : vscode.l10n.t('Failed to unlock worktree'));
}

export async function openWorktreeCommand(ctx: Ctx, view: WorktreesView, arg?: WorktreeArg & { branch?: string }) {
  if (arg?.branch) {
    const repo = await repoFor(ctx, arg);
    const wt = (await listWorktrees(repo)).find(w => w.branch === arg.branch && !samePath(w.path, repo.root));
    if (wt) return openWorktree(wt.path);
  }
  const sel = await resolve(ctx, view, arg);
  if (sel) await openWorktree(sel.wt.path);
}

/**
 * Before checking out `branch`: when it is checked out in another worktree, asks like IntelliJ's
 * "Worktree Conflict" dialog. Returns 'proceed' (use --ignore-other-worktrees), 'opened' or 'cancel',
 * or 'none' when there is no conflict.
 */
export async function checkWorktreeConflict(repo: Repository, branch: string): Promise<'none' | 'proceed' | 'opened' | 'cancel'> {
  const list = await listWorktrees(repo);
  const wt = list.find(w => w.branch === branch && !samePath(w.path, repo.root));
  if (!wt) return 'none';
  const checkoutAnyway = vscode.l10n.t('Checkout Anyway');
  const openExisting = vscode.l10n.t('Open Existing Worktree');
  const a = await vscode.window.showInformationMessage(
    vscode.l10n.t('Worktree Conflict'),
    { modal: true, detail: vscode.l10n.t("Branch '{0}' is already checked out in a worktree at:\n{1}", branch, wt.path.replace(os.homedir(), '~')) },
    checkoutAnyway,
    openExisting,
  );
  if (a === checkoutAnyway) return 'proceed';
  if (a === openExisting) {
    await openWorktree(wt.path);
    return 'opened';
  }
  return 'cancel';
}
