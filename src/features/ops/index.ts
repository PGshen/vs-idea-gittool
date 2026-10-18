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

  c('ideagittool.ops.pickToolbarRepository', () => bar.pickProjectRepo());
  registerMainMenu(ctx, () => bar.activeRepo());

  // Remote operations
  c('ideagittool.push', (arg?: { root?: string; upTo?: string; branch?: string }) => r.pushCommand(ctx, normalize(arg)));
  c('ideagittool.fetch', (arg?: { root?: string }) => r.fetchCommand(ctx, normalize(arg)));
  c('ideagittool.pull', (arg?: { root?: string }) => r.pullCommand(ctx, normalize(arg)));
  c('ideagittool.updateProject', (arg?: { root?: string }) => u.updateProjectCommand(ctx, normalize(arg)));
  c('ideagittool.updateForcePushedBranch', (arg?: { root?: string }) => u.updateForcePushedBranchCommand(ctx, normalize(arg)));
  c('ideagittool.resetToRemoteBranch', (arg?: { root?: string }) => u.resetToRemoteCommand(ctx, normalize(arg)));
  c('ideagittool.remotes', (arg?: { root?: string }) => r.remotesCommand(ctx, normalize(arg)));
  c('ideagittool.clone', () => r.cloneCommand(ctx));
  c('ideagittool.init', () => r.initCommand(ctx));
  c('ideagittool.unshallow', (arg?: { root?: string }) => r.unshallowCommand(ctx, normalize(arg)));

  // Branches
  c('ideagittool.branches', (arg?: { root?: string }) => b.branchesPopup(ctx, normalize(arg) ?? (bar.activeRepo() ? { root: bar.activeRepo()!.root } : undefined)));
  c('ideagittool.createBranch', (arg?: { root?: string; startPoint?: string }) => b.newBranchCommand(ctx, normalize(arg)));
  c('ideagittool.branch.checkout', (arg: b.BranchArg) => b.checkoutRef(ctx, arg));
  c('ideagittool.branch.newBranchFrom', (arg: b.BranchArg) => b.newBranchFrom(ctx, arg));
  c('ideagittool.branch.checkoutAndRebase', (arg: b.BranchArg) => b.checkoutAndRebase(ctx, arg));
  c('ideagittool.branch.checkoutAndUpdate', (arg: b.BranchArg) => b.checkoutAndUpdate(ctx, arg));
  c('ideagittool.branch.compare', (arg: b.BranchArg) => b.compareWithCurrent(ctx, arg));
  c('ideagittool.branch.showDiffWithWorkingTree', (arg: b.BranchArg) => b.showDiffWithWorkingTree(ctx, arg));
  c('ideagittool.branch.rebaseCurrentOnto', (arg: b.BranchArg) => b.rebaseCurrentOnto(ctx, arg));
  c('ideagittool.branch.mergeIntoCurrent', (arg: b.BranchArg) => b.mergeIntoCurrent(ctx, arg));
  c('ideagittool.branch.pullRebase', (arg: b.BranchArg) => b.pullInto(ctx, arg, true));
  c('ideagittool.branch.pullMerge', (arg: b.BranchArg) => b.pullInto(ctx, arg, false));
  c('ideagittool.branch.push', (arg: b.BranchArg) => b.pushBranch(ctx, arg));
  c('ideagittool.branch.update', (arg: b.BranchArg) => b.updateBranch(ctx, arg));
  c('ideagittool.branch.rename', (arg: b.BranchArg) => b.renameBranch(ctx, arg));
  c('ideagittool.branch.delete', (arg: b.BranchArg) => b.deleteBranch(ctx, arg));
  c('ideagittool.branch.toggleFavorite', (arg: b.BranchArg) => b.toggleFavorite(ctx, arg));
  c('ideagittool.branch.trackRemote', (arg: b.BranchArg) => b.trackRemote(ctx, arg));
  c('ideagittool.tag.checkout', (arg: b.BranchArg) => b.checkoutTag(ctx, arg));
  c('ideagittool.tag.mergeIntoCurrent', (arg: b.BranchArg) => b.mergeTag(ctx, arg));
  c('ideagittool.tag.push', (arg: b.BranchArg) => b.pushTag(ctx, arg));
  c('ideagittool.tag.delete', (arg: b.BranchArg) => b.deleteTag(ctx, arg));
  c('ideagittool.copyBranchName', async (arg?: { root?: string }) => {
    const repo = await repoFor(ctx, normalize(arg));
    await vscode.env.clipboard.writeText(repo.info.branch ?? repo.info.headHash ?? '');
  });

  // Worktrees
  const worktrees = new w.WorktreesView(ctx);
  ctx.extension.subscriptions.push(worktrees);
  c('ideagittool.worktrees.create', (arg?: { root?: string; ref?: string }) => w.createWorktreeCommand(ctx, normalize(arg), worktrees));
  c('ideagittool.worktrees.show', () => vscode.commands.executeCommand('ideagittool.worktrees.focus'));
  c('ideagittool.worktrees.refresh', () => worktrees.refresh());
  c('ideagittool.worktrees.open', (arg?: w.WorktreeArg & { branch?: string }) => w.openWorktreeCommand(ctx, worktrees, arg));
  c('ideagittool.worktrees.delete', (arg?: w.WorktreeArg) => w.deleteWorktreeCommand(ctx, worktrees, arg));
  c('ideagittool.worktrees.prune', (arg?: { root?: string }) => w.pruneWorktreesCommand(ctx, worktrees, normalize(arg)));
  c('ideagittool.worktrees.lock', (arg?: w.WorktreeArg) => w.toggleLockCommand(ctx, worktrees, arg, true));
  c('ideagittool.worktrees.unlock', (arg?: w.WorktreeArg) => w.toggleLockCommand(ctx, worktrees, arg, false));

  // History editing and repository operations
  c('ideagittool.merge', (arg?: { root?: string; branch?: string }) => h.mergeCommand(ctx, normalize(arg)));
  c('ideagittool.rebase', (arg?: { root?: string; upstream?: string }) => h.rebaseCommand(ctx, normalize(arg)));
  c('ideagittool.resetHead', (arg?: { root?: string; hash?: string }) => h.resetCommand(ctx, normalize(arg)));
  c('ideagittool.createTag', (arg?: { root?: string; hash?: string }) => h.createTagCommand(ctx, normalize(arg)));
  c('ideagittool.checkoutRevision', (arg: { root: string; hash: string }) => h.checkoutRevisionCommand(ctx, arg));
  c('ideagittool.cherryPick', (arg: { root: string; hashes: string[] }) => h.cherryPickCommand(ctx, arg));
  c('ideagittool.revertCommits', (arg: { root: string; hashes: string[] }) => h.revertCommand(ctx, arg));
  c('ideagittool.undoCommit', (arg: { root: string; hash: string }) => h.undoCommitCommand(ctx, arg));
  c('ideagittool.rewordCommit', (arg: { root: string; hash: string }) => h.rewordCommand(ctx, arg));
  c('ideagittool.fixupCommit', (arg: { root: string; hash: string; squash?: boolean }) => h.fixupCommand(ctx, arg));
  c('ideagittool.squashCommits', (arg: { root: string; hashes: string[] }) => h.squashCommand(ctx, arg));
  c('ideagittool.dropCommits', (arg: { root: string; hashes: string[] }) => h.dropCommand(ctx, arg));
  c('ideagittool.interactiveRebase', (arg: { root: string; hash: string }) => h.interactiveRebaseCommand(ctx, arg));
  c('ideagittool.createPatch', (arg?: { root?: string; hashes?: string[] }) => h.createPatchCommand(ctx, normalize(arg)));
  c('ideagittool.applyPatch', (arg?: { root?: string; clipboard?: boolean }) => h.applyPatchCommand(ctx, normalize(arg)));
  c('ideagittool.applyPatchFromClipboard', (arg?: { root?: string }) => h.applyPatchCommand(ctx, { ...normalize(arg), clipboard: true }));
  c('ideagittool.abortOperation', (arg?: { root?: string }) => h.abortCommand(ctx, normalize(arg)));
  c('ideagittool.continueOperation', (arg?: { root?: string }) => h.continueCommand(ctx, normalize(arg)));
  c('ideagittool.skipCommit', (arg?: { root?: string }) => h.skipCommand(ctx, normalize(arg)));
}

/** Menus pass a URI or SourceControl; command palette passes nothing. Only plain `{root}` objects are kept. */
function normalize<T extends object>(arg: T | undefined): T | undefined {
  if (!arg || typeof arg !== 'object' || arg instanceof vscode.Uri) return undefined;
  return arg;
}
