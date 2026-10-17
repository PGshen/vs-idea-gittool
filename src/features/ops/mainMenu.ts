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
    item('Commit File', 'rebased.commit', { args: a }),
    item('Add', 'rebased.addToVcs', { icon: 'general/add', shortcut: 'Ctrl+Alt+A', args: a }),
    item('Add to .gitignore', 'rebased.addToGitignore', { args: a }),
    sep(),
    item('Annotate with Git Blame', 'rebased.annotate', { args: a }),
    item('Compare with Same Repository Version', 'rebased.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
    item('Compare with Revision…', 'rebased.compareWithRevision', { args: a }),
    item('Compare with Branch or Tag…', 'rebased.compareWithBranch', { args: a }),
    item('Show History', 'rebased.showFileHistory', { icon: 'general/history', args: a }),
    item('Show History for Selection…', 'rebased.showHistoryForSelection'),
  ];
}

/** Git.MainMenu in Rebased order (state dependent items are hidden when not applicable). */
export function mainMenuItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const op = repo?.detectOperation() ?? 'none';
  const items: MenuItem[] = [
    item('Commit…', 'rebased.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item('Push…', 'rebased.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item('Update Project', 'rebased.updateProject', { icon: 'vcs/update', shortcut: 'Ctrl+T' }),
    item('Pull…', 'rebased.pull', { args: root }),
    item('Fetch', 'rebased.fetch', { icon: 'vcs/fetch' }),
  ];
  if (repo?.info.shallow) items.push(item('Unshallow repository', 'rebased.unshallow', { args: root }));
  items.push(sep(), item('Merge…', 'rebased.merge', { icon: 'vcs/merge', args: root }));
  if (op === 'merge') items.push(item('Commit merge', 'rebased.continueOperation', { args: root }), item('Abort Merge', 'rebased.abortOperation', { args: root }));
  items.push(item('Rebase…', 'rebased.rebase', { args: root }));
  if (op === 'rebase')
    items.push({
      label: 'Rebase',
      description: '▸',
      children: () => [
        item('Abort Rebase', 'rebased.abortOperation', { icon: 'vcs/abort', args: root }),
        item('Continue Rebase', 'rebased.continueOperation', { icon: 'dvcs/resolveContinue', args: root }),
        item('Skip Commit', 'rebased.skipCommit', { icon: 'dvcs/skipCommit', args: root }),
      ],
    });
  items.push(item('Resolve Conflicts…', 'rebased.resolveConflicts', { args: root }));
  items.push(
    sep(),
    item('Branches…', 'rebased.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item('New Branch…', 'rebased.createBranch', { icon: 'general/add', shortcut: 'Ctrl+Alt+N', args: root }),
    item('New Tag…', 'rebased.createTag', { args: root }),
    item('Reset HEAD…', 'rebased.resetHead', { args: root }),
    sep(),
    item('New Worktree…', 'rebased.worktrees.create', { args: root }),
    item('Worktrees…', 'rebased.worktrees.show'),
    sep(),
    item('Show Git Log', 'rebased.showLog', { icon: 'toolwindows/vcs', args: root }),
    {
      label: 'Patch',
      description: '▸',
      children: () => [
        item('Create Patch from Local Changes…', 'rebased.createPatch', { icon: 'vcs/patch', args: root }),
        item('Apply Patch…', 'rebased.applyPatch', { args: root }),
        item('Apply Patch from Clipboard…', 'rebased.applyPatch', { args: [{ ...(root[0] ?? {}), clipboard: true }] }),
      ],
    },
    {
      label: 'Uncommitted Changes',
      description: '▸',
      children: () => [
        item('Shelve Changes…', 'rebased.shelve', { icon: 'vcsimpl/stash' }),
        item('Show Shelf', 'rebased.showShelf'),
        item('Show Git Stash', 'rebased.showStashes'),
        item('Stash Changes…', 'rebased.stash', { args: root }),
        item('Unstash Changes…', 'rebased.unstash', { args: root }),
        item('Rollback…', 'rebased.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
      ],
    },
    { label: 'Current File', description: '▸', children: fileActions },
    sep(),
    item('Manage Remotes…', 'rebased.remotes', { args: root }),
    item('Clone…', 'rebased.clone'),
    sep(),
    item('VCS Operations Popup…', 'rebased.vcsOperationsPopup', { shortcut: 'Alt+`' }),
  );
  if (op === 'revert') items.push(sep(), item('Abort Revert', 'rebased.abortOperation', { args: root }));
  if (op === 'cherry-pick') items.push(sep(), item('Continue Cherry-Pick', 'rebased.continueOperation', { args: root }), item('Abort Cherry-Pick', 'rebased.abortOperation', { args: root }));
  return items;
}

/** VCS Operations Popup (Alt+`): GitQuickListContentProvider items, then generic VCS actions. */
export function quickListItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const uri = fileUri();
  const a = uri ? [uri] : [];
  const items: MenuItem[] = [
    sep('Git'),
    item('Commit…', 'rebased.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item('Branches…', 'rebased.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item('Push…', 'rebased.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item('Stash Changes…', 'rebased.stash', { args: root }),
    item('Unstash Changes…', 'rebased.unstash', { args: root }),
    sep(),
    item('Add to VCS', 'rebased.addToVcs', { args: a }),
    item('Copy Current Branch Name', 'rebased.copyBranchName', { args: root }),
  ];
  if (repo?.status.conflicts.length) items.push(item('Resolve Conflicts…', 'rebased.resolveConflicts', { args: root }));
  if (repo?.info.shallow) items.push(item('Unshallow repository', 'rebased.unshallow', { args: root }));
  items.push(
    sep(),
    item('Rollback…', 'rebased.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
    sep(),
    item('Show History', 'rebased.showFileHistory', { icon: 'general/history', args: a }),
    item('Annotate', 'rebased.annotate', { args: a }),
    item('Compare with Same Repository Version', 'rebased.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
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
  ctx.command('rebased.mainMenu', () => showMenuPick('Git', mainMenuItems(activeRepo())));
  ctx.command('rebased.vcsOperationsPopup', () => showMenuPick('VCS Operations', quickListItems(activeRepo())));
  ctx.command('rebased.currentFileMenu', () => showMenuPick('Current File', fileActions()));
}
