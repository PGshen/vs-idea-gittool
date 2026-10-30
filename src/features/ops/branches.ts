import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { openMultiDiff } from '../../host/gitContent';
import { withProgress } from '../../host/ui';
import { showError } from '../../host/webviewHost';
import { ActionItem } from '../../shared/branchesProtocol';
import { Ref } from '../../shared/types';
import { NEW_WORKTREE, OPEN_WORKTREE, refActionModel } from './branchActions';
import { diffChanges } from './changes';
import { putLocalHistoryLabel, remoteOf, repoFor, reportOutcome, RootArg, settings, withSmartOperation } from './common';
import { checkWorktreeConflict } from './worktrees';
import { checkout, isAncestor, validateNewBranch, worktreeOfBranch } from './engine';
import { merge, rebase } from './history';
import { ijIcon } from './icons';
import { pull, pushCommand } from './remote';
import { updateProjectCommand } from './update';

export type RefKind = 'local' | 'remote' | 'tag';

export interface BranchArg extends RootArg {
  name: string;
  type?: RefKind;
}

// ------------------------------------------------------------------ branches tab helpers

/** Branches checked out recently, from the HEAD reflog ("checkout: moving from A to B"). */
export async function recentBranches(repo: Repository, limit = 5): Promise<string[]> {
  const out = await repo.execText(['reflog', 'show', '--format=%gs', '-n', '300', 'HEAD', '--'], { quiet: true, allowFailure: true });
  const seen: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(line);
    if (!m) continue;
    for (const b of [m[2], m[1]]) {
      if (b === repo.info.branch || seen.includes(b)) continue;
      if (repo.refs.some(r => r.type === 'local' && r.name === b)) seen.push(b);
    }
    if (seen.length >= limit) break;
  }
  return seen;
}

/** Synchronous branch control (Settings | Git: "Execute branch operations on all roots"). */
export function syncControl(ctx: Ctx) {
  return ctx.repos.repositories.length > 1 && settings().get<boolean>('branches.syncControl', true);
}

/**
 * Runs one action of a ref submenu (see refActionModel). With `roots` (synchronous branch control) the action
 * runs in every repository, root by root like IntelliJ; New Branch from… shows one dialog for all of them.
 */
export async function runRefAction(ctx: Ctx, repo: Repository, ref: Ref, action: string, roots?: string[]) {
  const arg = { root: repo.root, name: ref.name, type: ref.type as RefKind };
  if (action === OPEN_WORKTREE) return vscode.commands.executeCommand('ideagittool.worktrees.open', { root: repo.root, branch: ref.name });
  if (action === NEW_WORKTREE) return vscode.commands.executeCommand('ideagittool.worktrees.create', { root: repo.root, ref: ref.name });
  if (action === 'ideagittool.branch.newBranchFrom' && roots) return newBranchCommand(ctx, { roots, startPoint: ref.name, title: translate('Create Branch from {0}', ref.name) });
  for (const root of roots ?? [repo.root]) await vscode.commands.executeCommand(action, { ...arg, root });
}

/** The submenu of a ref, as shown by the Branches tab. */
export async function refActionsFor(repo: Repository, ref: Ref, opts: { sync?: boolean; mac: boolean }): Promise<ActionItem[]> {
  const otherWorktree = ref.type === 'local' && !opts.sync ? !!(await worktreeOfBranch(repo, ref.name)) : false;
  return refActionModel(ref as Ref & { type: RefKind }, { currentBranch: repo.info.branch, otherWorktree, sync: opts.sync, mac: opts.mac });
}

export async function checkoutTagOrRevision(ctx: Ctx, repo: Repository) {
  const refs = repo.refs.map(r => ({ value: r.name, icon: r.type === 'tag' ? 'nodes/tag' : 'general/vcs', group: r.type === 'local' ? translate('Local') : r.type === 'remote' ? translate('Remote') : translate('Tags') }));
  await showDialog('ops.checkoutRevision', { refs }, {
    title: translate('Checkout Tag or Revision'),
    validate: async (v: { ref: string }) => {
      const ok = await repo.exec(['rev-parse', '-q', '--verify', `${v.ref}^{commit}`], { allowFailure: true, quiet: true });
      if (ok.exitCode !== 0) return translate('Revision not found: {0}', v.ref);
      setTimeout(() => void vscode.commands.executeCommand('ideagittool.checkoutRevision', { root: repo.root, hash: v.ref }), 0);
      return true;
    },
  });
}

// ------------------------------------------------------------------ branch commands

function findRef(repo: Repository, arg: BranchArg): Ref | undefined {
  return repo.refs.find(r => r.name === arg.name && (!arg.type || r.type === arg.type));
}

export async function newBranchCommand(ctx: Ctx, arg?: RootArg & { startPoint?: string; title?: string; roots?: string[] }) {
  if (arg?.roots && arg.roots.length > 1) return newBranchInRoots(ctx, arg.roots, arg.startPoint, arg.title);
  const repo = await repoFor(ctx, arg);
  const start = arg?.startPoint;
  const startRef = start ? repo.refs.find(r => r.name === start) : undefined;
  const initial = startRef?.type === 'remote' ? start!.slice((startRef.remote?.length ?? 0) + 1) : '';
  const title = arg?.title ?? (start ? translate('Create Branch from {0}', startRef ? start : start.slice(0, 8)) : translate('Create New Branch'));
  const res = await showDialog<{ name: string; checkout: boolean; overwrite: boolean }>(
    'ops.newBranch',
    {
      title,
      okLabel: translate('Create'),
      initial,
      mode: 'create',
      checkout: true,
      showCheckout: true,
      showOverwrite: true,
      locals: repo.refs.filter(r => r.type === 'local').map(r => r.name),
      remotes: repo.refs.filter(r => r.type === 'remote').map(r => r.name),
    },
    { title, validate: (v: { name: string; overwrite: boolean }) => validateNewBranch(repo, v.name, v.overwrite) ?? true },
  );
  if (!res) return;
  const from = start ?? 'HEAD';
  if (res.checkout) {
    if (res.overwrite && repo.info.branch === res.name) throw new Error(translate('Cannot overwrite current branch {0}', res.name));
    const outcome = await withSmartOperation(repo, 'checkout', force =>
      repo.batch(() => checkout(repo, from, { newBranch: res.name, overwrite: res.overwrite, force, track: startRef?.type === 'remote' ? undefined : false })),
      { destination: start ?? res.name },
    );
    if (!outcome) return;
    if (outcome.kind === 'success') void vscode.window.showInformationMessage(start ? translate('Checked out new branch {0} from {1}', res.name, start) : translate('Checked out new branch {0}', res.name));
    else await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: translate('Could not create new branch {0}', res.name) });
  } else {
    await repo.batch(() => repo.exec(['branch', ...(res.overwrite ? ['-f'] : []), res.name, from]));
    void vscode.window.showInformationMessage(translate('Branch {0} was created', res.name));
  }
}

/** New Branch… with synchronous branch control: one dialog, the branch is created in every repository. */
async function newBranchInRoots(ctx: Ctx, roots: string[], start?: string, title = start ? translate('Create Branch from {0}', start) : translate('Create New Branch')) {
  const repos = roots.map(r => ctx.repos.get(r)).filter((r): r is Repository => !!r);
  const res = await showDialog<{ name: string; checkout: boolean; overwrite: boolean }>(
    'ops.newBranch',
    {
      title,
      okLabel: translate('Create'),
      initial: '',
      mode: 'create',
      checkout: true,
      showCheckout: true,
      showOverwrite: true,
      locals: [...new Set(repos.flatMap(r => r.refs.filter(x => x.type === 'local').map(x => x.name)))],
      remotes: [...new Set(repos.flatMap(r => r.refs.filter(x => x.type === 'remote').map(x => x.name)))],
    },
    {
      title,
      validate: (v: { name: string; overwrite: boolean }) => {
        for (const r of repos) {
          const err = validateNewBranch(r, v.name, v.overwrite);
          if (err) return repos.length > 1 ? translate('{0} in {1}', err, r.name) : err;
        }
        return true;
      },
    },
  );
  if (!res) return;
  const failed: string[] = [];
  for (const repo of repos) {
    const from = start ?? 'HEAD';
    if (res.checkout) {
      const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => checkout(repo, from, { newBranch: res.name, overwrite: res.overwrite, force })), {
        destination: start ?? res.name,
      });
      if (outcome && outcome.kind !== 'success' && !(outcome.kind === 'conflicts' && outcome.handled)) {
        failed.push(repo.name);
        await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: translate('Could not create new branch {0}', res.name) });
      }
    } else {
      const r = await repo.batch(() => repo.exec(['branch', ...(res.overwrite ? ['-f'] : []), res.name, from], { allowFailure: true }));
      if (r.exitCode !== 0) failed.push(repo.name);
    }
  }
  if (!failed.length) void vscode.window.showInformationMessage(res.checkout ? translate('Checked out new branch {0}', res.name) : translate('Branch {0} was created', res.name));
}

export async function checkoutRef(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, arg);
  let target = arg.name;
  let opts: { newBranch?: string; track?: boolean } = {};
  let label = arg.name;
  if (ref?.type === 'remote') {
    // Checkout of a remote branch creates (or reuses) a tracking local branch with the same name.
    const localName = arg.name.slice((ref.remote?.length ?? 0) + 1);
    const local = repo.refs.find(r => r.type === 'local' && r.name === localName);
    if (!local) {
      opts = { newBranch: localName, track: true };
      label = localName;
    } else if (local.hash !== ref.hash && !(await isAncestor(repo, local.hash, ref.hash))) {
      const rebaseLabel = translate('Rebase');
      const a = await vscode.window.showWarningMessage(
        translate("Local branch '{0}' has commits that do not exist in '{1}'. Rebase '{0}' onto '{1}', or drop local commits?", localName, arg.name),
        { modal: true },
        rebaseLabel,
        translate('Drop Local Commits'),
      );
      if (!a) return;
      if (a === rebaseLabel) {
        await checkoutRef(ctx, { root: repo.root, name: localName, type: 'local' });
        await rebase(repo, [arg.name], localName, arg.name);
        return;
      }
      opts = { newBranch: localName, track: true };
      label = localName;
      const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => checkout(repo, target, { newBranch: localName, overwrite: true, force })), { destination: arg.name });
      if (outcome) await reportCheckout(repo, outcome, localName);
      return;
    } else {
      target = localName;
      label = localName;
      // Fast-forward the local branch to the remote one, like "Checkout" in IntelliJ when the local branch is behind.
      if (local.hash !== ref.hash) await repo.exec(['branch', '-f', localName, arg.name], { allowFailure: true });
    }
  }
  let ignoreOtherWorktrees = false;
  if (!opts.newBranch) {
    const conflict = await checkWorktreeConflict(repo, target);
    if (conflict === 'cancel' || conflict === 'opened') return;
    ignoreOtherWorktrees = conflict === 'proceed';
  }
  await putLocalHistoryLabel(repo, translate('Before Checkout'));
  const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => checkout(repo, target, { ...opts, force, ignoreOtherWorktrees })), { destination: arg.name });
  if (!outcome) return;
  await reportCheckout(repo, outcome, label, ref?.type === 'remote' && opts.newBranch ? arg.name : undefined);
}

async function reportCheckout(repo: Repository, outcome: Awaited<ReturnType<typeof checkout>>, name: string, from?: string) {
  if (outcome.kind === 'success') void vscode.window.showInformationMessage(from ? translate('Checked out new branch {0} from {1}', name, from) : translate('Checked out {0}', name));
  else await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: translate('Could not checkout {0}', name) });
}

export async function newBranchFrom(ctx: Ctx, arg: BranchArg) {
  await newBranchCommand(ctx, { root: arg.root, startPoint: arg.name, title: translate('Create Branch from {0}', arg.name) });
}

export async function checkoutAndRebase(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const cur = repo.info.branch;
  if (!cur) throw new Error(translate('Rebase is not possible in the detached HEAD state'));
  let branch = arg.name;
  const ref = findRef(repo, arg);
  if (ref?.type === 'remote') {
    // Creates a local branch for the remote one first.
    branch = arg.name.slice((ref.remote?.length ?? 0) + 1);
    if (!repo.refs.some(r => r.type === 'local' && r.name === branch)) await repo.exec(['branch', '--track', branch, arg.name]);
  }
  const ok = await rebase(repo, [cur, branch], branch, cur);
  if (ok) void vscode.window.showInformationMessage(translate('Checked out {0} and rebased it on {1}', branch, cur));
}

export async function checkoutAndUpdate(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await checkoutRef(ctx, { ...arg, type: 'local' });
  if (repo.info.branch === arg.name) await updateProjectCommand(ctx, { root: repo.root, method: settings().get('updateMethod') === 'rebase' ? 'rebase' : 'merge' });
}

export async function compareWithCurrent(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await vscode.commands.executeCommand('ideagittool.compareRefs', { root: repo.root, ref: arg.name, with: repo.info.branch ?? 'HEAD' });
}

export async function showDiffWithWorkingTree(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const changes = await diffChanges(repo, arg.name);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(translate('There are no changes between {0} and the working tree', arg.name));
    return;
  }
  // Left = ref, right = local file.
  await openMultiDiff(translate('{0} ↔ Working Tree', arg.name), changes, () => arg.name, () => 'WORKTREE');
}

export async function rebaseCurrentOnto(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  if (!repo.info.branch) throw new Error(translate('Rebase is not possible in the detached HEAD state'));
  await rebase(repo, [arg.name], repo.info.branch, arg.name);
}

export async function mergeIntoCurrent(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await merge(repo, arg.name);
}

export async function pullInto(ctx: Ctx, arg: BranchArg, useRebase: boolean) {
  const repo = await repoFor(ctx, arg);
  const remote = remoteOf(repo, arg.name);
  if (!remote) throw new Error(translate('{0} is not a remote branch', arg.name));
  await pull(repo, remote, arg.name.slice(remote.length + 1), useRebase ? ['rebase'] : []);
}

export async function pushBranch(ctx: Ctx, arg: BranchArg) {
  await pushCommand(ctx, { root: arg.root, branch: arg.name });
}

/** Update a branch: the current one with Update Project, others by fetching `remote branch:local` (fast-forward). */
export async function updateBranch(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  if (arg.name === repo.info.branch) return updateProjectCommand(ctx, { root: repo.root, method: settings().get('updateMethod') === 'rebase' ? 'rebase' : 'merge' });
  const ref = findRef(repo, { ...arg, type: 'local' });
  if (!ref?.upstream) throw new Error(translate('Tracked branch is not configured for {0}', arg.name));
  const remote = remoteOf(repo, ref.upstream)!;
  const remoteBranch = ref.upstream.slice(remote.length + 1);
  const r = await withProgress(translate('Updating branches…'), (progress, token) =>
    repo.exec(['fetch', '--progress', remote, `refs/heads/${remoteBranch}:refs/heads/${arg.name}`], { allowFailure: true, token, onStderrLine: progress }),
  );
  await repo.refresh();
  if (r.exitCode === 0) void vscode.window.showInformationMessage(translate('Updated {0}', arg.name));
  else if (/non-fast-forward|rejected/.test(r.stderr)) void vscode.window.showWarningMessage(translate('Update failed: {0} has diverged from {1} and cannot be fast-forwarded. Check it out and update it.', arg.name, ref.upstream));
  else showError(r.stderr, translate('Update failed'));
}

export async function renameBranch(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const locals = repo.refs.filter(r => r.type === 'local').map(r => r.name);
  const title = translate('Rename Branch {0}', arg.name);
  const res = await showDialog<{ name: string }>(
    'ops.newBranch',
    { title, okLabel: translate('Rename'), initial: arg.name, mode: 'rename', renaming: arg.name, locals, remotes: repo.refs.filter(r => r.type === 'remote').map(r => r.name) },
    { title, validate: (v: { name: string }) => (v.name === arg.name ? true : (validateNewBranch(repo, v.name, false) ?? true)) },
  );
  if (!res || res.name === arg.name) return;
  await repo.batch(() => repo.exec(['branch', '-m', arg.name, res.name]));
}

export async function deleteBranch(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, arg);
  if (!ref) throw new Error(translate('Branch {0} not found', arg.name));
  if (ref.type === 'remote') return deleteRemoteBranch(ctx, repo, ref);
  if (ref.current) throw new Error(translate('Cannot delete the current branch {0}', ref.name));
  const r = await repo.exec(['branch', '-d', ref.name], { allowFailure: true });
  if (r.exitCode !== 0) {
    if (!/not fully merged/.test(r.stderr)) return showError(r.stderr, translate('Could not delete {0}', ref.name));
    const base = repo.info.branch ?? 'HEAD';
    const commits = (await repo.execText(['log', '--format=%H%x00%s%x00%an%x00%at', `${base}..${ref.name}`, '-n', '200'], { quiet: true }))
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [hash, subject, author, at] = l.split('\0');
        return { hash, subject, author, date: +at };
      });
    const a = await showDialog<{ button: string }>('ops.notFullyMerged', { branch: ref.name, base, commits }, { title: translate('Branch Was Not Fully Merged') });
    if (a?.button !== 'delete') return;
    await repo.exec(['branch', '-D', ref.name]);
  }
  await repo.refresh();
  const restore = translate('Restore');
  const deleteTracked = translate('Delete Tracked Branch');
  const actions = [restore, ...(ref.upstream && !ref.upstreamGone ? [deleteTracked] : [])];
  const choice = await vscode.window.showInformationMessage(translate('Deleted branch {0}', ref.name), ...actions);
  if (choice === restore) {
    await repo.exec(['branch', ref.name, ref.hash]);
    if (ref.upstream) await repo.exec(['branch', '-u', ref.upstream, ref.name], { allowFailure: true });
    await repo.refresh();
  } else if (choice === deleteTracked) {
    const remoteRef = repo.refs.find(r => r.type === 'remote' && r.name === ref.upstream);
    if (remoteRef) await deleteRemoteBranch(ctx, repo, remoteRef, true);
  }
}

async function deleteRemoteBranch(ctx: Ctx, repo: Repository, ref: Ref, confirmed = false) {
  const remote = ref.remote ?? remoteOf(repo, ref.name)!;
  const branch = ref.name.slice(remote.length + 1);
  const trackingLocals = repo.refs.filter(r => r.type === 'local' && r.upstream === ref.name && !r.current);
  let deleteLocal = false;
  if (!confirmed) {
    const res = await showDialog<{ button: string; checked: boolean }>(
      'confirm',
      {
        title: translate('Delete Remote Branch'),
        message: translate('Delete remote branch {0}?', ref.name),
        icon: 'question',
        buttons: [
          { id: 'cancel', label: translate('Cancel') },
          { id: 'delete', label: translate('Delete'), primary: true },
        ],
        checkbox: trackingLocals.length ? translate('Delete tracking local branch {0} as well', trackingLocals.map(l => l.name).join(', ')) : undefined,
      },
      { title: translate('Delete Remote Branch') },
    );
    if (res?.button !== 'delete') return;
    deleteLocal = res.checked;
  }
  const r = await withProgress(translate('Deleting {0}…', ref.name), (progress, token) => repo.exec(['push', '--progress', remote, '--delete', branch], { allowFailure: true, token }));
  if (r.exitCode !== 0) {
    await repo.refresh();
    return showError(r.stderr, translate('Failed to delete remote branch {0}', ref.name));
  }
  if (deleteLocal) for (const l of trackingLocals) await repo.exec(['branch', '-D', l.name], { allowFailure: true });
  await repo.refresh();
  void vscode.window.showInformationMessage(translate('Deleted remote branch {0}', ref.name));
}

export async function trackRemote(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, { ...arg, type: 'local' });
  const items: (vscode.QuickPickItem & { remote?: string })[] = repo.refs
    .filter(r => r.type === 'remote')
    .map(r => ({ label: r.name, iconPath: ijIcon('general/vcs'), picked: r.name === ref?.upstream, remote: r.name, description: r.name === ref?.upstream ? translate('tracked') : undefined }));
  if (ref?.upstream) items.unshift({ label: translate('Unset Tracked Branch'), description: ref.upstream });
  const pick = await vscode.window.showQuickPick(items, { title: translate("Tracked Branch for '{0}'", arg.name), placeHolder: translate('Select a remote branch to track') });
  if (!pick) return;
  if (!pick.remote) await repo.exec(['branch', '--unset-upstream', arg.name]);
  else await repo.exec(['branch', '-u', pick.remote, arg.name]);
  await repo.refresh();
}

export async function toggleFavorite(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, arg);
  if (ref) await ctx.repos.toggleFavorite(repo, ref.fullName);
}

// ------------------------------------------------------------------ tag commands

export async function checkoutTag(ctx: Ctx, arg: BranchArg) {
  await vscode.commands.executeCommand('ideagittool.checkoutRevision', { root: arg.root, hash: `refs/tags/${arg.name}` });
}

export async function mergeTag(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await merge(repo, `refs/tags/${arg.name}`);
}

export async function pushTag(ctx: Ctx, arg: BranchArg & { remote?: string }) {
  const repo = await repoFor(ctx, arg);
  let remote = arg.remote;
  if (!remote) {
    if (repo.remotes.length === 0) throw new Error(translate('No remotes defined'));
    remote = repo.remotes.length === 1 ? repo.remotes[0].name : (await vscode.window.showQuickPick(repo.remotes.map(r => r.name), { title: translate('Push Tag {0} to', arg.name) }));
  }
  if (!remote) return;
  const r = await withProgress(translate('Pushing tag {0}…', arg.name), (progress, token) => repo.exec(['push', '--progress', remote!, `refs/tags/${arg.name}`], { allowFailure: true, token }));
  if (r.exitCode === 0) void vscode.window.showInformationMessage(translate('Push successful: Pushed tag {0} to {1}', arg.name, remote));
  else showError(r.stderr, translate('Push failed'));
}

export async function deleteTag(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, { ...arg, type: 'tag' });
  if (!ref) throw new Error(translate('Tag {0} not found', arg.name));
  const target = (await repo.execText(['rev-parse', `refs/tags/${arg.name}`], { quiet: true })).trim();
  await repo.batch(() => repo.exec(['tag', '-d', arg.name]));
  const remotes = repo.remotes.map(r => r.name);
  const restore = translate('Restore');
  const deleteOnRemote = remotes.length === 1 ? translate('Delete on Remote') : translate('Delete on Remotes');
  const a = await vscode.window.showInformationMessage(translate('Deleted Tag: {0}', arg.name), restore, ...(remotes.length ? [deleteOnRemote] : []));
  if (a === restore) {
    await repo.exec(['update-ref', `refs/tags/${arg.name}`, target]);
    await repo.refresh();
  } else if (a === deleteOnRemote) {
    for (const remote of remotes) {
      const r = await withProgress(translate('Deleting tag {0} on remote…', arg.name), () => repo.exec(['push', remote, '--delete', `refs/tags/${arg.name}`], { allowFailure: true }));
      if (r.exitCode !== 0 && !/remote ref does not exist/.test(r.stderr)) showError(r.stderr, translate('Failed to delete tag {0} on {1}', arg.name, remote));
    }
  }
}

