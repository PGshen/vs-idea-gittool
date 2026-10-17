import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { openMultiDiff } from '../../host/gitContent';
import { withProgress } from '../../host/ui';
import { CancelledError, showError } from '../../host/webviewHost';
import { Ref } from '../../shared/types';
import { diffChanges } from './changes';
import { currentName, remoteOf, repoFor, reportOutcome, RootArg, settings, withSmartOperation } from './common';
import { checkout, countCommits, fetch, isAncestor, runConflictAware, validateNewBranch } from './engine';
import { merge, rebase } from './history';
import { ijIcon } from './icons';
import { pull, pushCommand, updateProjectCommand } from './remote';

export type RefKind = 'local' | 'remote' | 'tag';

export interface BranchArg extends RootArg {
  name: string;
  type?: RefKind;
}

// ------------------------------------------------------------------ branches popup

interface PopupItem extends vscode.QuickPickItem {
  run?: () => unknown;
  ref?: Ref;
}

const SEP = vscode.QuickPickItemKind.Separator;

/** Branches checked out recently, from the HEAD reflog ("checkout: moving from A to B"). */
async function recentBranches(repo: Repository, limit = 5): Promise<string[]> {
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

function refIcon(ref: Ref) {
  if (ref.type === 'tag') return ijIcon('nodes/tag');
  if (ref.current) return ijIcon(ref.favorite ? 'dvcs/currentBranchFavoriteLabel' : 'dvcs/currentBranchLabel');
  if (ref.favorite) return ijIcon('nodes/star');
  return ijIcon('general/vcs');
}

function refDescription(ref: Ref) {
  const parts: string[] = [];
  if (ref.behind) parts.push(`↓${ref.behind}`);
  if (ref.ahead) parts.push(`↑${ref.ahead}`);
  if (ref.upstream) parts.push(ref.upstream);
  return parts.join('  ');
}

function refTooltip(ref: Ref) {
  const tips: string[] = [];
  if (ref.behind) tips.push(`${ref.behind} incoming ${ref.behind === 1 ? 'commit' : 'commits'}`);
  if (ref.ahead) tips.push(`${ref.ahead} outgoing ${ref.ahead === 1 ? 'commit' : 'commits'}`);
  return tips.join(', ');
}

/** `rebased.branches`: the Git branches popup (GitBranchesTreePopup). */
export async function branchesPopup(ctx: Ctx, arg?: RootArg) {
  let repo = await repoFor(ctx, arg);
  const qp = vscode.window.createQuickPick<PopupItem>();
  qp.matchOnDescription = false;
  qp.placeholder = 'Search for branches and actions';
  const fetchButton: vscode.QuickInputButton = { iconPath: ijIcon('vcs/fetch'), tooltip: 'Fetch' };
  const settingsButton: vscode.QuickInputButton = { iconPath: ijIcon('general/moreVertical'), tooltip: 'Settings' };
  qp.buttons = [fetchButton, settingsButton];
  let disposed = false;

  const build = async () => {
    const r = repo;
    qp.title = ctx.repos.repositories.length > 1 ? `Git Branches in ${r.name}` : 'Git Branches';
    const items: PopupItem[] = [];
    if (ctx.repos.repositories.length > 1) {
      items.push({
        label: `Repository: ${r.name}`,
        description: 'Switch repository…',
        iconPath: ijIcon('nodes/folder'),
        alwaysShow: true,
        run: async () => {
          const picked = await vscode.window.showQuickPick(
            ctx.repos.repositories.map(x => ({ label: x.name, description: currentName(x), detail: x.root, repo: x })),
            { placeHolder: 'Select repository' },
          );
          if (picked) {
            repo = picked.repo;
            await build();
          }
          qp.show();
          return 'keep';
        },
      });
    }
    // Rebased: Update Project and Push are on the toolbar; only Commit… remains at the top.
    items.push({ label: 'Commit…', iconPath: ijIcon('vcs/commit'), alwaysShow: false, run: () => vscode.commands.executeCommand('rebased.commit') });
    items.push({ label: '', kind: SEP });
    for (const a of ongoingActions(r)) items.push({ ...a, alwaysShow: true });
    items.push({ label: 'New Branch…', iconPath: ijIcon('general/add'), description: 'Ctrl+Alt+N', run: () => newBranchCommand(ctx, { root: r.root }) });
    items.push({ label: 'Checkout Tag or Revision…', run: () => checkoutTagOrRevision(ctx, r) });
    const showRecent = settings().get<boolean>('branches.showRecent', true);
    const showTags = settings().get<boolean>('branches.showTags', true);
    const locals = r.refs.filter(x => x.type === 'local');
    const branchItem = (ref: Ref): PopupItem => ({
      label: ref.name,
      description: refDescription(ref),
      detail: undefined,
      iconPath: refIcon(ref),
      ref,
      tooltip: refTooltip(ref),
      buttons: ref.type !== 'tag' ? [{ iconPath: ijIcon(ref.favorite ? 'nodes/star' : 'nodes/starEmpty'), tooltip: ref.favorite ? 'Remove from Favorites' : 'Add to Favorites' }] : [],
    } as PopupItem);
    if (showRecent) {
      const recent = await recentBranches(r);
      if (recent.length) {
        items.push({ label: 'Recent', kind: SEP });
        for (const b of recent) items.push({ ...branchItem(locals.find(x => x.name === b)!), id: `recent:${b}` } as PopupItem);
      }
    }
    items.push({ label: 'Local', kind: SEP });
    const sortRefs = (a: Ref, b: Ref) => (a.current ? -1 : b.current ? 1 : a.favorite !== b.favorite ? (a.favorite ? -1 : 1) : a.name.localeCompare(b.name));
    for (const ref of [...locals].sort(sortRefs)) items.push(branchItem(ref));
    const remotes = r.refs.filter(x => x.type === 'remote');
    if (remotes.length) {
      items.push({ label: 'Remote', kind: SEP });
      for (const ref of [...remotes].sort(sortRefs)) items.push(branchItem(ref));
    }
    const tags = r.refs.filter(x => x.type === 'tag');
    if (showTags && tags.length) {
      items.push({ label: 'Tags', kind: SEP });
      for (const ref of [...tags].sort((a, b) => (b.date ?? 0) - (a.date ?? 0))) items.push(branchItem(ref));
    }
    qp.items = items;
  };

  qp.onDidTriggerButton(async b => {
    if (b === fetchButton) {
      qp.busy = true;
      await withProgress('Fetching…', (progress, token) => fetch(repo, 'all', { progress, token }), { location: 'window' });
      await repo.refresh();
      qp.busy = false;
      await build();
    } else if (b === settingsButton) {
      const cfg = settings();
      const toggles = [
        { label: 'Show Recent Branches', key: 'branches.showRecent', picked: cfg.get('branches.showRecent', true) },
        { label: 'Show Tags', key: 'branches.showTags', picked: cfg.get('branches.showTags', true) },
      ];
      const sel = await vscode.window.showQuickPick(toggles, { canPickMany: true, title: 'Branches Popup Settings' });
      if (sel) for (const t of toggles) await cfg.update(t.key, sel.includes(t), vscode.ConfigurationTarget.Global);
      await build();
      qp.show();
    }
  });
  qp.onDidTriggerItemButton(async e => {
    if (e.item.ref) {
      await ctx.repos.toggleFavorite(repo, e.item.ref.fullName);
      await build();
    }
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    if (item.ref) {
      qp.hide();
      await refActionsPopup(ctx, repo, item.ref, () => branchesPopup(ctx, { root: repo.root }));
      return;
    }
    if (item.run) {
      const keep = item.label.startsWith('Repository:');
      if (!keep) qp.hide();
      try {
        await item.run();
      } catch (e) {
        showError(e);
      }
    }
  });
  qp.onDidHide(() => {
    disposed = true;
    qp.dispose();
  });
  await build();
  if (!disposed) qp.show();
}

function ongoingActions(repo: Repository): PopupItem[] {
  const root = { root: repo.root };
  const run = (cmd: string) => () => vscode.commands.executeCommand(cmd, root);
  switch (repo.detectOperation()) {
    case 'rebase':
      return [
        { label: 'Abort Rebase', iconPath: ijIcon('vcs/abort'), run: run('rebased.abortOperation') },
        { label: 'Continue Rebase', iconPath: ijIcon('dvcs/resolveContinue'), run: run('rebased.continueOperation') },
        { label: 'Skip Commit', iconPath: ijIcon('dvcs/skipCommit'), run: run('rebased.skipCommit') },
      ];
    case 'merge':
      return [{ label: 'Abort Merge', iconPath: ijIcon('vcs/abort'), run: run('rebased.abortOperation') }];
    case 'cherry-pick':
      return [
        { label: 'Abort Cherry-Pick', iconPath: ijIcon('vcs/abort'), run: run('rebased.abortOperation') },
        { label: 'Continue Cherry-Pick', iconPath: ijIcon('dvcs/resolveContinue'), run: run('rebased.continueOperation') },
      ];
    case 'revert':
      return [{ label: 'Abort Revert', iconPath: ijIcon('vcs/abort'), run: run('rebased.abortOperation') }];
    default:
      return [];
  }
}

/** Per-ref submenu (Git.Branch group), with labels per ref kind as in GitBranchPopupActions. */
export function refActions(ctx: Ctx, repo: Repository, ref: Ref): PopupItem[] {
  const cur = repo.info.branch;
  const current = ref.type === 'local' && ref.current;
  const arg = { root: repo.root, name: ref.name, type: ref.type as RefKind };
  const cmd = (id: string) => () => vscode.commands.executeCommand(id, arg);
  const items: PopupItem[] = [];
  const sep = () => items.push({ label: '', kind: SEP });
  const isTag = ref.type === 'tag';
  const ns = isTag ? 'rebased.tag' : 'rebased.branch';
  if (!current) items.push({ label: 'Checkout', run: cmd(`${ns}.checkout`) });
  items.push({ label: `New Branch from '${ref.name}'…`, iconPath: ijIcon('general/add'), run: cmd('rebased.branch.newBranchFrom') });
  if (!current && !isTag && cur) items.push({ label: `Checkout and Rebase onto '${cur}'`, run: cmd('rebased.branch.checkoutAndRebase') });
  if (ref.type === 'local' && !current && ref.upstream) items.push({ label: 'Checkout and Update', run: cmd('rebased.branch.checkoutAndUpdate') });
  sep();
  if (!current && cur) items.push({ label: `Compare with '${cur}'`, run: cmd('rebased.branch.compare') });
  items.push({ label: 'Show Diff with Working Tree', iconPath: ijIcon('vcs/diff'), run: cmd('rebased.branch.showDiffWithWorkingTree') });
  sep();
  if (!current && cur) {
    items.push({ label: `Rebase '${cur}' onto '${ref.name}'`, run: cmd('rebased.branch.rebaseCurrentOnto') });
    items.push({ label: `Merge '${ref.name}' into '${cur}'`, iconPath: ijIcon('vcs/merge'), run: cmd(isTag ? 'rebased.tag.mergeIntoCurrent' : 'rebased.branch.mergeIntoCurrent') });
  }
  sep();
  if (ref.type === 'local') {
    if (ref.upstream || current) items.push({ label: 'Update', iconPath: ijIcon('vcs/update'), run: cmd('rebased.branch.update') });
    items.push({ label: 'Push…', iconPath: ijIcon('vcs/push'), description: 'Ctrl+Shift+K', run: cmd('rebased.branch.push') });
    items.push({ label: ref.upstream ? `Tracked Branch '${ref.upstream}'…` : 'Set Tracked Branch…', run: cmd('rebased.branch.trackRemote') });
  }
  if (ref.type === 'remote' && cur) {
    items.push({ label: `Pull into '${cur}' Using Rebase`, run: cmd('rebased.branch.pullRebase') });
    items.push({ label: `Pull into '${cur}' Using Merge`, run: cmd('rebased.branch.pullMerge') });
  }
  sep();
  if (isTag) items.push({ label: 'Push Tag', iconPath: ijIcon('vcs/push'), run: cmd('rebased.tag.push') });
  sep();
  if (ref.type === 'local') items.push({ label: 'Rename…', description: 'F2', run: cmd('rebased.branch.rename') });
  if (!current) items.push({ label: 'Delete', iconPath: ijIcon('general/delete'), description: 'Delete', run: cmd(`${ns}.delete`) });
  // Drop leading / trailing / doubled separators.
  return items.filter((it, i, all) => it.kind !== SEP || (i > 0 && i < all.length - 1 && all[i - 1].kind !== SEP));
}

async function refActionsPopup(ctx: Ctx, repo: Repository, ref: Ref, back: () => unknown) {
  const qp = vscode.window.createQuickPick<PopupItem>();
  qp.title = ref.type === 'tag' ? `Tag '${ref.name}'` : `Branch '${ref.name}'`;
  qp.items = refActions(ctx, repo, ref);
  qp.buttons = [vscode.QuickInputButtons.Back];
  qp.placeholder = ref.upstream ? `Tracking ${ref.upstream}` : undefined;
  let goBack = false;
  qp.onDidTriggerButton(b => {
    if (b === vscode.QuickInputButtons.Back) {
      goBack = true;
      qp.hide();
    }
  });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    qp.hide();
    try {
      await it?.run?.();
    } catch (e) {
      showError(e);
    }
  });
  qp.onDidHide(() => {
    qp.dispose();
    if (goBack) void back();
  });
  qp.show();
}

async function checkoutTagOrRevision(ctx: Ctx, repo: Repository) {
  const refs = repo.refs.map(r => ({ value: r.name, icon: r.type === 'tag' ? 'nodes/tag' : 'general/vcs', group: r.type === 'local' ? 'Local' : r.type === 'remote' ? 'Remote' : 'Tags' }));
  await showDialog('ops.checkoutRevision', { refs }, {
    title: 'Checkout Tag or Revision',
    validate: async (v: { ref: string }) => {
      const ok = await repo.exec(['rev-parse', '-q', '--verify', `${v.ref}^{commit}`], { allowFailure: true, quiet: true });
      if (ok.exitCode !== 0) return `Revision not found: ${v.ref}`;
      setTimeout(() => void vscode.commands.executeCommand('rebased.checkoutRevision', { root: repo.root, hash: v.ref }), 0);
      return true;
    },
  });
}

// ------------------------------------------------------------------ branch commands

function findRef(repo: Repository, arg: BranchArg): Ref | undefined {
  return repo.refs.find(r => r.name === arg.name && (!arg.type || r.type === arg.type));
}

export async function newBranchCommand(ctx: Ctx, arg?: RootArg & { startPoint?: string; title?: string }) {
  const repo = await repoFor(ctx, arg);
  const start = arg?.startPoint;
  const startRef = start ? repo.refs.find(r => r.name === start) : undefined;
  const initial = startRef?.type === 'remote' ? start!.slice((startRef.remote?.length ?? 0) + 1) : '';
  const title = arg?.title ?? (start ? `Create Branch from ${startRef ? start : start.slice(0, 8)}` : 'Create New Branch');
  const res = await showDialog<{ name: string; checkout: boolean; overwrite: boolean }>(
    'ops.newBranch',
    {
      title,
      okLabel: 'Create',
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
    if (res.overwrite && repo.info.branch === res.name) throw new Error(`Cannot overwrite current branch ${res.name}`);
    const outcome = await withSmartOperation(repo, 'checkout', force =>
      repo.batch(() => checkout(repo, from, { newBranch: res.name, overwrite: res.overwrite, force, track: startRef?.type === 'remote' ? undefined : false })),
    );
    if (!outcome) return;
    if (outcome.kind === 'success') void vscode.window.showInformationMessage(start ? `Checked out new branch ${res.name} from ${start}` : `Checked out new branch ${res.name}`);
    else await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: `Could not create new branch ${res.name}` });
  } else {
    await repo.batch(() => repo.exec(['branch', ...(res.overwrite ? ['-f'] : []), res.name, from]));
    void vscode.window.showInformationMessage(`Branch ${res.name} was created`);
  }
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
      const a = await vscode.window.showWarningMessage(
        `Local branch '${localName}' has commits that do not exist in '${arg.name}'. Rebase '${localName}' onto '${arg.name}', or drop local commits?`,
        { modal: true },
        'Rebase',
        'Drop Local Commits',
      );
      if (!a) return;
      if (a === 'Rebase') {
        await checkoutRef(ctx, { root: repo.root, name: localName, type: 'local' });
        await rebase(repo, [arg.name], localName, arg.name);
        return;
      }
      opts = { newBranch: localName, track: true };
      label = localName;
      const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => checkout(repo, target, { newBranch: localName, overwrite: true, force })));
      if (outcome) await reportCheckout(repo, outcome, localName);
      return;
    } else {
      target = localName;
      label = localName;
      // Fast-forward the local branch to the remote one, like "Checkout" in IntelliJ when the local branch is behind.
      if (local.hash !== ref.hash) await repo.exec(['branch', '-f', localName, arg.name], { allowFailure: true });
    }
  }
  const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => checkout(repo, target, { ...opts, force })));
  if (!outcome) return;
  await reportCheckout(repo, outcome, label, ref?.type === 'remote' && opts.newBranch ? arg.name : undefined);
}

async function reportCheckout(repo: Repository, outcome: Awaited<ReturnType<typeof checkout>>, name: string, from?: string) {
  if (outcome.kind === 'success') void vscode.window.showInformationMessage(from ? `Checked out new branch ${name} from ${from}` : `Checked out ${name}`);
  else await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: `Could not checkout ${name}` });
}

export async function newBranchFrom(ctx: Ctx, arg: BranchArg) {
  await newBranchCommand(ctx, { root: arg.root, startPoint: arg.name, title: `Create Branch from ${arg.name}` });
}

export async function checkoutAndRebase(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const cur = repo.info.branch;
  if (!cur) throw new Error('Rebase is not possible in the detached HEAD state');
  let branch = arg.name;
  const ref = findRef(repo, arg);
  if (ref?.type === 'remote') {
    // Creates a local branch for the remote one first.
    branch = arg.name.slice((ref.remote?.length ?? 0) + 1);
    if (!repo.refs.some(r => r.type === 'local' && r.name === branch)) await repo.exec(['branch', '--track', branch, arg.name]);
  }
  const ok = await rebase(repo, [cur, branch], branch, cur);
  if (ok) void vscode.window.showInformationMessage(`Checked out ${branch} and rebased it on ${cur}`);
}

export async function checkoutAndUpdate(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await checkoutRef(ctx, { ...arg, type: 'local' });
  if (repo.info.branch === arg.name) await updateProjectCommand(ctx, { root: repo.root, method: settings().get('updateMethod') === 'rebase' ? 'rebase' : 'merge' });
}

export async function compareWithCurrent(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await vscode.commands.executeCommand('rebased.compareRefs', { root: repo.root, ref: arg.name, with: repo.info.branch ?? 'HEAD' });
}

export async function showDiffWithWorkingTree(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const changes = await diffChanges(repo, arg.name);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(`There are no changes between ${arg.name} and the working tree`);
    return;
  }
  // Left = ref, right = local file.
  await openMultiDiff(`${arg.name} ↔ Working Tree`, changes, () => arg.name, () => 'WORKTREE');
}

export async function rebaseCurrentOnto(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  if (!repo.info.branch) throw new Error('Rebase is not possible in the detached HEAD state');
  await rebase(repo, [arg.name], repo.info.branch, arg.name);
}

export async function mergeIntoCurrent(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await merge(repo, arg.name);
}

export async function pullInto(ctx: Ctx, arg: BranchArg, useRebase: boolean) {
  const repo = await repoFor(ctx, arg);
  const remote = remoteOf(repo, arg.name);
  if (!remote) throw new Error(`${arg.name} is not a remote branch`);
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
  if (!ref?.upstream) throw new Error(`Tracked branch is not configured for ${arg.name}`);
  const remote = remoteOf(repo, ref.upstream)!;
  const remoteBranch = ref.upstream.slice(remote.length + 1);
  const r = await withProgress('Updating branches…', (progress, token) =>
    repo.exec(['fetch', '--progress', remote, `refs/heads/${remoteBranch}:refs/heads/${arg.name}`], { allowFailure: true, token, onStderrLine: progress }),
  );
  await repo.refresh();
  if (r.exitCode === 0) void vscode.window.showInformationMessage(`Updated ${arg.name}`);
  else if (/non-fast-forward|rejected/.test(r.stderr)) void vscode.window.showWarningMessage(`Update failed: ${arg.name} has diverged from ${ref.upstream} and cannot be fast-forwarded. Check it out and update it.`);
  else showError(r.stderr, 'Update failed');
}

export async function renameBranch(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const locals = repo.refs.filter(r => r.type === 'local').map(r => r.name);
  const title = `Rename Branch ${arg.name}`;
  const res = await showDialog<{ name: string }>(
    'ops.newBranch',
    { title, okLabel: 'Rename', initial: arg.name, mode: 'rename', renaming: arg.name, locals, remotes: repo.refs.filter(r => r.type === 'remote').map(r => r.name) },
    { title, validate: (v: { name: string }) => (v.name === arg.name ? true : (validateNewBranch(repo, v.name, false) ?? true)) },
  );
  if (!res || res.name === arg.name) return;
  await repo.batch(() => repo.exec(['branch', '-m', arg.name, res.name]));
}

export async function deleteBranch(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, arg);
  if (!ref) throw new Error(`Branch ${arg.name} not found`);
  if (ref.type === 'remote') return deleteRemoteBranch(ctx, repo, ref);
  if (ref.current) throw new Error(`Cannot delete the current branch ${ref.name}`);
  const r = await repo.exec(['branch', '-d', ref.name], { allowFailure: true });
  if (r.exitCode !== 0) {
    if (!/not fully merged/.test(r.stderr)) return showError(r.stderr, `Could not delete ${ref.name}`);
    const base = repo.info.branch ?? 'HEAD';
    const commits = (await repo.execText(['log', '--format=%H%x00%s%x00%an%x00%at', `${base}..${ref.name}`, '-n', '200'], { quiet: true }))
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [hash, subject, author, at] = l.split('\0');
        return { hash, subject, author, date: +at };
      });
    const a = await showDialog<{ button: string }>('ops.notFullyMerged', { branch: ref.name, base, commits }, { title: 'Branch Was Not Fully Merged' });
    if (a?.button !== 'delete') return;
    await repo.exec(['branch', '-D', ref.name]);
  }
  await repo.refresh();
  const actions = ['Restore', ...(ref.upstream && !ref.upstreamGone ? ['Delete Tracked Branch'] : [])];
  const choice = await vscode.window.showInformationMessage(`Deleted branch ${ref.name}`, ...actions);
  if (choice === 'Restore') {
    await repo.exec(['branch', ref.name, ref.hash]);
    if (ref.upstream) await repo.exec(['branch', '-u', ref.upstream, ref.name], { allowFailure: true });
    await repo.refresh();
  } else if (choice === 'Delete Tracked Branch') {
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
        title: 'Delete Remote Branch',
        message: `Delete remote branch ${ref.name}?`,
        icon: 'question',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'delete', label: 'Delete', primary: true },
        ],
        checkbox: trackingLocals.length ? `Delete tracking local branch ${trackingLocals.map(l => l.name).join(', ')} as well` : undefined,
      },
      { title: 'Delete Remote Branch' },
    );
    if (res?.button !== 'delete') return;
    deleteLocal = res.checked;
  }
  const r = await withProgress(`Deleting ${ref.name}…`, (progress, token) => repo.exec(['push', '--progress', remote, '--delete', branch], { allowFailure: true, token }));
  if (r.exitCode !== 0) {
    await repo.refresh();
    return showError(r.stderr, `Failed to delete remote branch ${ref.name}`);
  }
  if (deleteLocal) for (const l of trackingLocals) await repo.exec(['branch', '-D', l.name], { allowFailure: true });
  await repo.refresh();
  void vscode.window.showInformationMessage(`Deleted remote branch ${ref.name}`);
}

export async function trackRemote(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, { ...arg, type: 'local' });
  const items: (vscode.QuickPickItem & { remote?: string })[] = repo.refs
    .filter(r => r.type === 'remote')
    .map(r => ({ label: r.name, iconPath: ijIcon('general/vcs'), picked: r.name === ref?.upstream, remote: r.name, description: r.name === ref?.upstream ? 'tracked' : undefined }));
  if (ref?.upstream) items.unshift({ label: 'Unset Tracked Branch', description: ref.upstream });
  const pick = await vscode.window.showQuickPick(items, { title: `Tracked Branch for '${arg.name}'`, placeHolder: 'Select a remote branch to track' });
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
  await vscode.commands.executeCommand('rebased.checkoutRevision', { root: arg.root, hash: `refs/tags/${arg.name}` });
}

export async function mergeTag(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  await merge(repo, `refs/tags/${arg.name}`);
}

export async function pushTag(ctx: Ctx, arg: BranchArg & { remote?: string }) {
  const repo = await repoFor(ctx, arg);
  let remote = arg.remote;
  if (!remote) {
    if (repo.remotes.length === 0) throw new Error('No remotes defined');
    remote = repo.remotes.length === 1 ? repo.remotes[0].name : (await vscode.window.showQuickPick(repo.remotes.map(r => r.name), { title: `Push Tag ${arg.name} to` }));
  }
  if (!remote) return;
  const r = await withProgress(`Pushing tag ${arg.name}…`, (progress, token) => repo.exec(['push', '--progress', remote!, `refs/tags/${arg.name}`], { allowFailure: true, token }));
  if (r.exitCode === 0) void vscode.window.showInformationMessage(`Push successful: Pushed tag ${arg.name} to ${remote}`);
  else showError(r.stderr, 'Push failed');
}

export async function deleteTag(ctx: Ctx, arg: BranchArg) {
  const repo = await repoFor(ctx, arg);
  const ref = findRef(repo, { ...arg, type: 'tag' });
  if (!ref) throw new Error(`Tag ${arg.name} not found`);
  const target = (await repo.execText(['rev-parse', `refs/tags/${arg.name}`], { quiet: true })).trim();
  await repo.batch(() => repo.exec(['tag', '-d', arg.name]));
  const remotes = repo.remotes.map(r => r.name);
  const a = await vscode.window.showInformationMessage(`Deleted Tag: ${arg.name}`, 'Restore', ...(remotes.length ? [remotes.length === 1 ? `Delete on Remote` : 'Delete on Remotes'] : []));
  if (a === 'Restore') {
    await repo.exec(['update-ref', `refs/tags/${arg.name}`, target]);
    await repo.refresh();
  } else if (a?.startsWith('Delete on')) {
    for (const remote of remotes) {
      const r = await withProgress(`Deleting tag ${arg.name} on remote…`, () => repo.exec(['push', remote, '--delete', `refs/tags/${arg.name}`], { allowFailure: true }));
      if (r.exitCode !== 0 && !/remote ref does not exist/.test(r.stderr)) showError(r.stderr, `Failed to delete tag ${arg.name} on ${remote}`);
    }
  }
}

