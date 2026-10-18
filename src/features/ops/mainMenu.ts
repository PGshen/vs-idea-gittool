import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showError } from '../../host/webviewHost';
import { ijIcon } from './icons';

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
  args?: unknown[];
  children?: () => MenuItem[];
}

const SEP = vscode.QuickPickItemKind.Separator;

function item(label: string, command: string, opts: { icon?: string; shortcut?: string; args?: unknown[] } = {}): MenuItem {
  return { label, command, description: opts.shortcut, iconPath: opts.icon ? ijIcon(opts.icon) : undefined, args: opts.args };
}

function sep(label = ''): MenuItem {
  return { label, kind: SEP };
}

function fileUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' ? uri : undefined;
}

/** Git.FileActions: the "Current File" submenu. */
export function fileActions(): MenuItem[] {
  const uri = fileUri();
  const a = uri ? [uri] : [];
  return [
    item('Commit File', 'ideagittool.commit', { args: a }),
    item('Add', 'ideagittool.addToVcs', { icon: 'general/add', shortcut: 'Ctrl+Alt+A', args: a }),
    item('Add to .gitignore', 'ideagittool.addToGitignore', { args: a }),
    sep(),
    item('Annotate with Git Blame', 'ideagittool.annotate', { args: a }),
    item('Compare with Same Repository Version', 'ideagittool.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
    item('Compare with Revision…', 'ideagittool.compareWithRevision', { args: a }),
    item('Compare with Branch or Tag…', 'ideagittool.compareWithBranch', { args: a }),
    item('Show History', 'ideagittool.showFileHistory', { icon: 'general/history', args: a }),
    item('Show History for Selection…', 'ideagittool.showHistoryForSelection'),
  ];
}

/** Git.MainMenu in IdeaGitTool order (state dependent items are hidden when not applicable). */
export function mainMenuItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const op = repo?.detectOperation() ?? 'none';
  const items: MenuItem[] = [
    item('Commit…', 'ideagittool.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item('Push…', 'ideagittool.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item('Update Project', 'ideagittool.updateProject', { icon: 'vcs/update', shortcut: 'Ctrl+T' }),
    item('Pull…', 'ideagittool.pull', { args: root }),
    item('Fetch', 'ideagittool.fetch', { icon: 'vcs/fetch' }),
  ];
  if (repo?.info.shallow) items.push(item('Unshallow repository', 'ideagittool.unshallow', { args: root }));
  items.push(sep(), item('Merge…', 'ideagittool.merge', { icon: 'vcs/merge', args: root }));
  if (op === 'merge') items.push(item('Commit merge', 'ideagittool.continueOperation', { args: root }), item('Abort Merge', 'ideagittool.abortOperation', { args: root }));
  items.push(item('Rebase…', 'ideagittool.rebase', { args: root }));
  if (op === 'rebase')
    items.push({
      label: 'Rebase',
      description: '▸',
      children: () => [
        item('Abort Rebase', 'ideagittool.abortOperation', { icon: 'vcs/abort', args: root }),
        item('Continue Rebase', 'ideagittool.continueOperation', { icon: 'dvcs/resolveContinue', args: root }),
        item('Skip Commit', 'ideagittool.skipCommit', { icon: 'dvcs/skipCommit', args: root }),
      ],
    });
  items.push(item('Resolve Conflicts…', 'ideagittool.resolveConflicts', { args: root }));
  items.push(
    sep(),
    item('Branches…', 'ideagittool.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item('New Branch…', 'ideagittool.createBranch', { icon: 'general/add', shortcut: 'Ctrl+Alt+N', args: root }),
    item('New Tag…', 'ideagittool.createTag', { args: root }),
    item('Reset HEAD…', 'ideagittool.resetHead', { args: root }),
    sep(),
    item('New Worktree…', 'ideagittool.worktrees.create', { args: root }),
    item('Worktrees…', 'ideagittool.worktrees.show'),
    sep(),
    item('Show Git Log', 'ideagittool.showLog', { icon: 'toolwindows/vcs', args: root }),
    {
      label: 'Patch',
      description: '▸',
      children: () => [
        item('Create Patch from Local Changes…', 'ideagittool.createPatch', { icon: 'vcs/patch', args: root }),
        item('Apply Patch…', 'ideagittool.applyPatch', { args: root }),
        item('Apply Patch from Clipboard…', 'ideagittool.applyPatch', { args: [{ ...(root[0] ?? {}), clipboard: true }] }),
      ],
    },
    {
      label: 'Uncommitted Changes',
      description: '▸',
      children: () => [
        item('Shelve Changes…', 'ideagittool.shelve', { icon: 'vcsimpl/stash' }),
        item('Show Shelf', 'ideagittool.showShelf'),
        item('Show Git Stash', 'ideagittool.showStashes'),
        item('Stash Changes…', 'ideagittool.stash', { args: root }),
        item('Unstash Changes…', 'ideagittool.unstash', { args: root }),
        item('Rollback…', 'ideagittool.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
      ],
    },
    { label: 'Current File', description: '▸', children: fileActions },
    sep(),
    item('Manage Remotes…', 'ideagittool.remotes', { args: root }),
    item('Clone…', 'ideagittool.clone'),
    sep(),
    item('VCS Operations Popup…', 'ideagittool.vcsOperationsPopup', { shortcut: 'Alt+`' }),
  );
  if (op === 'revert') items.push(sep(), item('Abort Revert', 'ideagittool.abortOperation', { args: root }));
  if (op === 'cherry-pick') items.push(sep(), item('Continue Cherry-Pick', 'ideagittool.continueOperation', { args: root }), item('Abort Cherry-Pick', 'ideagittool.abortOperation', { args: root }));
  return items;
}

/** VCS Operations Popup (Alt+`): GitQuickListContentProvider items, then generic VCS actions. */
export function quickListItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const uri = fileUri();
  const a = uri ? [uri] : [];
  const items: MenuItem[] = [
    sep('Git'),
    item('Commit…', 'ideagittool.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item('Branches…', 'ideagittool.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item('Push…', 'ideagittool.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item('Stash Changes…', 'ideagittool.stash', { args: root }),
    item('Unstash Changes…', 'ideagittool.unstash', { args: root }),
    sep(),
    item('Add to VCS', 'ideagittool.addToVcs', { args: a }),
    item('Copy Current Branch Name', 'ideagittool.copyBranchName', { args: root }),
  ];
  if (repo?.status.conflicts.length) items.push(item('Resolve Conflicts…', 'ideagittool.resolveConflicts', { args: root }));
  if (repo?.info.shallow) items.push(item('Unshallow repository', 'ideagittool.unshallow', { args: root }));
  items.push(
    sep(),
    item('Rollback…', 'ideagittool.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
    sep(),
    item('Show History', 'ideagittool.showFileHistory', { icon: 'general/history', args: a }),
    item('Annotate', 'ideagittool.annotate', { args: a }),
    item('Compare with Same Repository Version', 'ideagittool.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
    sep(),
    { label: 'Git', description: '▸', children: () => mainMenuItems(repo) },
  );
  return items;
}

/** Shows a menu of commands as a QuickPick; submenus open nested pickers with a Back button. */
export async function showMenuPick(title: string, items: MenuItem[], parent?: () => Promise<void>): Promise<void> {
  const qp = vscode.window.createQuickPick<MenuItem>();
  qp.title = title;
  qp.items = items;
  if (parent) qp.buttons = [vscode.QuickInputButtons.Back];
  let next: (() => Promise<void>) | undefined;
  qp.onDidTriggerButton(() => {
    next = parent;
    qp.hide();
  });
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    if (!it) return;
    if (it.children) {
      next = () => showMenuPick(it.label, it.children!(), () => showMenuPick(title, items, parent));
      qp.hide();
      return;
    }
    qp.hide();
    if (it.command)
      Promise.resolve(vscode.commands.executeCommand(it.command, ...(it.args ?? []))).catch(e => showError(e));
  });
  qp.onDidHide(() => {
    qp.dispose();
    void next?.();
  });
  qp.show();
}

export function registerMainMenu(ctx: Ctx, activeRepo: () => Repository | undefined) {
  ctx.command('ideagittool.mainMenu', () => showMenuPick('Git', mainMenuItems(activeRepo())));
  ctx.command('ideagittool.vcsOperationsPopup', () => showMenuPick('VCS Operations', quickListItems(activeRepo())));
  ctx.command('ideagittool.currentFileMenu', () => showMenuPick('Current File', fileActions()));
}
