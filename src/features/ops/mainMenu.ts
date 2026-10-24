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
    item(vscode.l10n.t('Commit File'), 'ideagittool.commit', { args: a }),
    item(vscode.l10n.t('Add'), 'ideagittool.addToVcs', { icon: 'general/add', shortcut: 'Ctrl+Alt+A', args: a }),
    item(vscode.l10n.t('Add to .gitignore'), 'ideagittool.addToGitignore', { args: a }),
    sep(),
    item(vscode.l10n.t('Annotate with Git Blame'), 'ideagittool.annotate', { args: a }),
    item(vscode.l10n.t('Compare with Same Repository Version'), 'ideagittool.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
    item(vscode.l10n.t('Compare with Revision…'), 'ideagittool.compareWithRevision', { args: a }),
    item(vscode.l10n.t('Compare with Branch or Tag…'), 'ideagittool.compareWithBranch', { args: a }),
    item(vscode.l10n.t('Show History'), 'ideagittool.showFileHistory', { icon: 'general/history', args: a }),
    item(vscode.l10n.t('Show History for Selection…'), 'ideagittool.showHistoryForSelection'),
  ];
}

/** Git.MainMenu in IdeaGitTool order (state dependent items are hidden when not applicable). */
export function mainMenuItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const op = repo?.detectOperation() ?? 'none';
  const items: MenuItem[] = [
    item(vscode.l10n.t('Commit…'), 'ideagittool.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item(vscode.l10n.t('Push…'), 'ideagittool.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item(vscode.l10n.t('Update Project'), 'ideagittool.updateProject', { icon: 'vcs/update', shortcut: 'Ctrl+T' }),
    item(vscode.l10n.t('Pull…'), 'ideagittool.pull', { args: root }),
    item(vscode.l10n.t('Fetch'), 'ideagittool.fetch', { icon: 'vcs/fetch' }),
  ];
  if (repo?.info.shallow) items.push(item(vscode.l10n.t('Unshallow repository'), 'ideagittool.unshallow', { args: root }));
  items.push(sep(), item(vscode.l10n.t('Merge…'), 'ideagittool.merge', { icon: 'vcs/merge', args: root }));
  if (op === 'merge') items.push(item(vscode.l10n.t('Commit merge'), 'ideagittool.continueOperation', { args: root }), item(vscode.l10n.t('Abort Merge'), 'ideagittool.abortOperation', { args: root }));
  items.push(item(vscode.l10n.t('Rebase…'), 'ideagittool.rebase', { args: root }));
  if (op === 'rebase')
    items.push({
      label: vscode.l10n.t('Rebase'),
      description: '▸',
      children: () => [
        item(vscode.l10n.t('Abort Rebase'), 'ideagittool.abortOperation', { icon: 'vcs/abort', args: root }),
        item(vscode.l10n.t('Continue Rebase'), 'ideagittool.continueOperation', { icon: 'dvcs/resolveContinue', args: root }),
        item(vscode.l10n.t('Skip Commit'), 'ideagittool.skipCommit', { icon: 'dvcs/skipCommit', args: root }),
      ],
    });
  items.push(item(vscode.l10n.t('Resolve Conflicts…'), 'ideagittool.resolveConflicts', { args: root }));
  items.push(
    sep(),
    item(vscode.l10n.t('Branches…'), 'ideagittool.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item(vscode.l10n.t('New Branch…'), 'ideagittool.createBranch', { icon: 'general/add', shortcut: 'Ctrl+Alt+N', args: root }),
    item(vscode.l10n.t('New Tag…'), 'ideagittool.createTag', { args: root }),
    item(vscode.l10n.t('Reset HEAD…'), 'ideagittool.resetHead', { args: root }),
    sep(),
    item(vscode.l10n.t('New Worktree…'), 'ideagittool.worktrees.create', { args: root }),
    item(vscode.l10n.t('Worktrees…'), 'ideagittool.worktrees.show'),
    sep(),
    item(vscode.l10n.t('Show Git Log'), 'ideagittool.showLog', { icon: 'toolwindows/vcs', args: root }),
    {
      label: vscode.l10n.t('Patch'),
      description: '▸',
      children: () => [
        item(vscode.l10n.t('Create Patch from Local Changes…'), 'ideagittool.createPatch', { icon: 'vcs/patch', args: root }),
        item(vscode.l10n.t('Apply Patch…'), 'ideagittool.applyPatch', { args: root }),
        item(vscode.l10n.t('Apply Patch from Clipboard…'), 'ideagittool.applyPatch', { args: [{ ...(root[0] ?? {}), clipboard: true }] }),
      ],
    },
    {
      label: vscode.l10n.t('Uncommitted Changes'),
      description: '▸',
      children: () => [
        item(vscode.l10n.t('Shelve Changes…'), 'ideagittool.shelve', { icon: 'vcsimpl/stash' }),
        item(vscode.l10n.t('Show Shelf'), 'ideagittool.showShelf'),
        item(vscode.l10n.t('Show Git Stash'), 'ideagittool.showStashes'),
        item(vscode.l10n.t('Stash Changes…'), 'ideagittool.stash', { args: root }),
        item(vscode.l10n.t('Unstash Changes…'), 'ideagittool.unstash', { args: root }),
        item(vscode.l10n.t('Rollback…'), 'ideagittool.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
      ],
    },
    { label: vscode.l10n.t('Current File'), description: '▸', children: fileActions },
    sep(),
    item(vscode.l10n.t('Manage Remotes…'), 'ideagittool.remotes', { args: root }),
    item(vscode.l10n.t('Clone…'), 'ideagittool.clone'),
    sep(),
    item(vscode.l10n.t('VCS Operations Popup…'), 'ideagittool.vcsOperationsPopup', { shortcut: 'Alt+`' }),
  );
  if (op === 'revert') items.push(sep(), item(vscode.l10n.t('Abort Revert'), 'ideagittool.abortOperation', { args: root }));
  if (op === 'cherry-pick') items.push(sep(), item(vscode.l10n.t('Continue Cherry-Pick'), 'ideagittool.continueOperation', { args: root }), item(vscode.l10n.t('Abort Cherry-Pick'), 'ideagittool.abortOperation', { args: root }));
  return items;
}

/** VCS Operations Popup (Alt+`): GitQuickListContentProvider items, then generic VCS actions. */
export function quickListItems(repo: Repository | undefined): MenuItem[] {
  const root = repo ? [{ root: repo.root }] : [];
  const uri = fileUri();
  const a = uri ? [uri] : [];
  const items: MenuItem[] = [
    sep('Git'),
    item(vscode.l10n.t('Commit…'), 'ideagittool.commit', { icon: 'vcs/commit', shortcut: 'Ctrl+K' }),
    item(vscode.l10n.t('Branches…'), 'ideagittool.branches', { icon: 'general/vcs', shortcut: 'Ctrl+Shift+`', args: root }),
    item(vscode.l10n.t('Push…'), 'ideagittool.push', { icon: 'vcs/push', shortcut: 'Ctrl+Shift+K' }),
    item(vscode.l10n.t('Stash Changes…'), 'ideagittool.stash', { args: root }),
    item(vscode.l10n.t('Unstash Changes…'), 'ideagittool.unstash', { args: root }),
    sep(),
    item(vscode.l10n.t('Add to VCS'), 'ideagittool.addToVcs', { args: a }),
    item(vscode.l10n.t('Copy Current Branch Name'), 'ideagittool.copyBranchName', { args: root }),
  ];
  if (repo?.status.conflicts.length) items.push(item(vscode.l10n.t('Resolve Conflicts…'), 'ideagittool.resolveConflicts', { args: root }));
  if (repo?.info.shallow) items.push(item(vscode.l10n.t('Unshallow repository'), 'ideagittool.unshallow', { args: root }));
  items.push(
    sep(),
    item(vscode.l10n.t('Rollback…'), 'ideagittool.rollback', { icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z' }),
    sep(),
    item(vscode.l10n.t('Show History'), 'ideagittool.showFileHistory', { icon: 'general/history', args: a }),
    item(vscode.l10n.t('Annotate'), 'ideagittool.annotate', { args: a }),
    item(vscode.l10n.t('Compare with Same Repository Version'), 'ideagittool.showLocalDiff', { icon: 'vcs/diff', shortcut: 'Ctrl+D', args: a }),
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
  ctx.command('ideagittool.vcsOperationsPopup', () => showMenuPick(vscode.l10n.t('VCS Operations'), quickListItems(activeRepo())));
  ctx.command('ideagittool.currentFileMenu', () => showMenuPick(vscode.l10n.t('Current File'), fileActions()));
}
