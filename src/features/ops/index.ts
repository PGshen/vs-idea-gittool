import * as vscode from 'vscode';
import { Ctx } from '../../context';
import * as b from './branches';
import { repoFor } from './common';
import * as h from './history';
import { registerMainMenu } from './mainMenu';
import * as r from './remote';
import { StatusBarWidgets } from './statusBar';
import * as u from './update';
import * as w from './worktrees';

/**
 * Git operations: branches popup, toolbar widgets, push / update / pull / fetch, merge / rebase,
 * interactive rebase and commit editing, reset, tags, remotes, clone and patches.
 */
export function register(ctx: Ctx) {
  const bar = new StatusBarWidgets(ctx);
  ctx.extension.subscriptions.push(bar);
  const c = ctx.command.bind(ctx);

  c('rebased.ops.pickToolbarRepository', () => bar.pickProjectRepo());
  registerMainMenu(ctx, () => bar.activeRepo());

  // Remote operations
  c('rebased.push', (arg?: { root?: string; upTo?: string; branch?: string }) => r.pushCommand(ctx, normalize(arg)));
  c('rebased.fetch', (arg?: { root?: string }) => r.fetchCommand(ctx, normalize(arg)));
  c('rebased.pull', (arg?: { root?: string }) => r.pullCommand(ctx, normalize(arg)));
  c('rebased.updateProject', (arg?: { root?: string }) => u.updateProjectCommand(ctx, normalize(arg)));
  c('rebased.updateForcePushedBranch', (arg?: { root?: string }) => u.updateForcePushedBranchCommand(ctx, normalize(arg)));
  c('rebased.resetToRemoteBranch', (arg?: { root?: string }) => u.resetToRemoteCommand(ctx, normalize(arg)));
  c('rebased.remotes', (arg?: { root?: string }) => r.remotesCommand(ctx, normalize(arg)));
  c('rebased.clone', () => r.cloneCommand(ctx));
  c('rebased.init', () => r.initCommand(ctx));
  c('rebased.unshallow', (arg?: { root?: string }) => r.unshallowCommand(ctx, normalize(arg)));

  // Branches
  c('rebased.branches', (arg?: { root?: string }) => b.branchesPopup(ctx, normalize(arg) ?? (bar.activeRepo() ? { root: bar.activeRepo()!.root } : undefined)));
  c('rebased.createBranch', (arg?: { root?: string; startPoint?: string }) => b.newBranchCommand(ctx, normalize(arg)));
  c('rebased.branch.checkout', (arg: b.BranchArg) => b.checkoutRef(ctx, arg));
  c('rebased.branch.newBranchFrom', (arg: b.BranchArg) => b.newBranchFrom(ctx, arg));
  c('rebased.branch.checkoutAndRebase', (arg: b.BranchArg) => b.checkoutAndRebase(ctx, arg));
  c('rebased.branch.checkoutAndUpdate', (arg: b.BranchArg) => b.checkoutAndUpdate(ctx, arg));
  c('rebased.branch.compare', (arg: b.BranchArg) => b.compareWithCurrent(ctx, arg));
  c('rebased.branch.showDiffWithWorkingTree', (arg: b.BranchArg) => b.showDiffWithWorkingTree(ctx, arg));
  c('rebased.branch.rebaseCurrentOnto', (arg: b.BranchArg) => b.rebaseCurrentOnto(ctx, arg));
  c('rebased.branch.mergeIntoCurrent', (arg: b.BranchArg) => b.mergeIntoCurrent(ctx, arg));
  c('rebased.branch.pullRebase', (arg: b.BranchArg) => b.pullInto(ctx, arg, true));
  c('rebased.branch.pullMerge', (arg: b.BranchArg) => b.pullInto(ctx, arg, false));
  c('rebased.branch.push', (arg: b.BranchArg) => b.pushBranch(ctx, arg));
  c('rebased.branch.update', (arg: b.BranchArg) => b.updateBranch(ctx, arg));
  c('rebased.branch.rename', (arg: b.BranchArg) => b.renameBranch(ctx, arg));
  c('rebased.branch.delete', (arg: b.BranchArg) => b.deleteBranch(ctx, arg));
  c('rebased.branch.toggleFavorite', (arg: b.BranchArg) => b.toggleFavorite(ctx, arg));
  c('rebased.branch.trackRemote', (arg: b.BranchArg) => b.trackRemote(ctx, arg));
  c('rebased.tag.checkout', (arg: b.BranchArg) => b.checkoutTag(ctx, arg));
  c('rebased.tag.mergeIntoCurrent', (arg: b.BranchArg) => b.mergeTag(ctx, arg));
  c('rebased.tag.push', (arg: b.BranchArg) => b.pushTag(ctx, arg));
  c('rebased.tag.delete', (arg: b.BranchArg) => b.deleteTag(ctx, arg));
  c('rebased.copyBranchName', async (arg?: { root?: string }) => {
    const repo = await repoFor(ctx, normalize(arg));
    await vscode.env.clipboard.writeText(repo.info.branch ?? repo.info.headHash ?? '');
  });

  // Worktrees
  const worktrees = new w.WorktreesView(ctx);
  ctx.extension.subscriptions.push(worktrees);
  c('rebased.worktrees.create', (arg?: { root?: string; ref?: string }) => w.createWorktreeCommand(ctx, normalize(arg), worktrees));
  c('rebased.worktrees.show', () => vscode.commands.executeCommand('rebased.worktrees.focus'));
  c('rebased.worktrees.refresh', () => worktrees.refresh());
  c('rebased.worktrees.open', (arg?: w.WorktreeArg & { branch?: string }) => w.openWorktreeCommand(ctx, worktrees, arg));
  c('rebased.worktrees.delete', (arg?: w.WorktreeArg) => w.deleteWorktreeCommand(ctx, worktrees, arg));
  c('rebased.worktrees.prune', (arg?: { root?: string }) => w.pruneWorktreesCommand(ctx, worktrees, normalize(arg)));
  c('rebased.worktrees.lock', (arg?: w.WorktreeArg) => w.toggleLockCommand(ctx, worktrees, arg, true));
  c('rebased.worktrees.unlock', (arg?: w.WorktreeArg) => w.toggleLockCommand(ctx, worktrees, arg, false));

  // History editing and repository operations
  c('rebased.merge', (arg?: { root?: string; branch?: string }) => h.mergeCommand(ctx, normalize(arg)));
  c('rebased.rebase', (arg?: { root?: string; upstream?: string }) => h.rebaseCommand(ctx, normalize(arg)));
  c('rebased.resetHead', (arg?: { root?: string; hash?: string }) => h.resetCommand(ctx, normalize(arg)));
  c('rebased.createTag', (arg?: { root?: string; hash?: string }) => h.createTagCommand(ctx, normalize(arg)));
  c('rebased.checkoutRevision', (arg: { root: string; hash: string }) => h.checkoutRevisionCommand(ctx, arg));
  c('rebased.cherryPick', (arg: { root: string; hashes: string[] }) => h.cherryPickCommand(ctx, arg));
  c('rebased.revertCommits', (arg: { root: string; hashes: string[] }) => h.revertCommand(ctx, arg));
  c('rebased.undoCommit', (arg: { root: string; hash: string }) => h.undoCommitCommand(ctx, arg));
  c('rebased.rewordCommit', (arg: { root: string; hash: string }) => h.rewordCommand(ctx, arg));
  c('rebased.fixupCommit', (arg: { root: string; hash: string; squash?: boolean }) => h.fixupCommand(ctx, arg));
  c('rebased.squashCommits', (arg: { root: string; hashes: string[] }) => h.squashCommand(ctx, arg));
  c('rebased.dropCommits', (arg: { root: string; hashes: string[] }) => h.dropCommand(ctx, arg));
  c('rebased.interactiveRebase', (arg: { root: string; hash: string }) => h.interactiveRebaseCommand(ctx, arg));
  c('rebased.createPatch', (arg?: { root?: string; hashes?: string[] }) => h.createPatchCommand(ctx, normalize(arg)));
  c('rebased.applyPatch', (arg?: { root?: string; clipboard?: boolean }) => h.applyPatchCommand(ctx, normalize(arg)));
  c('rebased.applyPatchFromClipboard', (arg?: { root?: string }) => h.applyPatchCommand(ctx, { ...normalize(arg), clipboard: true }));
  c('rebased.abortOperation', (arg?: { root?: string }) => h.abortCommand(ctx, normalize(arg)));
  c('rebased.continueOperation', (arg?: { root?: string }) => h.continueCommand(ctx, normalize(arg)));
  c('rebased.skipCommit', (arg?: { root?: string }) => h.skipCommand(ctx, normalize(arg)));
}

/** Menus pass a URI or SourceControl; command palette passes nothing. Only plain `{root}` objects are kept. */
function normalize<T extends object>(arg: T | undefined): T | undefined {
  if (!arg || typeof arg !== 'object' || arg instanceof vscode.Uri) return undefined;
  return arg;
}
