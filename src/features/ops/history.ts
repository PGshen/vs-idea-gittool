import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { openChangeDiff } from '../../host/gitContent';
import { withProgress } from '../../host/ui';
import { CancelledError, showError } from '../../host/webviewHost';
import { Change } from '../../shared/types';
import { commitChanges } from './changes';
import { capitalize, currentName, putLocalHistoryLabel, repoFor, reportOutcome, RootArg, withSmartOperation } from './common';
import {
  commitMessages,
  dropCommits,
  fixupInto,
  interactiveRebase,
  isAncestor,
  loadRebaseCommits,
  nonInteractiveEnv,
  OperationOutcome,
  prettySquash,
  RebaseEntry,
  rebaseBaseFor,
  revParse,
  rewordCommit,
  runConflictAware,
  sortOldestFirst,
  squashCommits,
} from './engine';

interface CommitArg extends RootArg {
  hash: string;
}

interface CommitsArg extends RootArg {
  hashes: string[];
}

async function full(repo: Repository, hash: string) {
  return (await revParse(repo, hash)) ?? hash;
}

/** Shows a success notification with an "Undo" action that resets back to `oldHead` (like IntelliJ's log edits). */
async function notifyWithUndo(repo: Repository, title: string, oldHead: string | undefined) {
  const newHead = await revParse(repo, 'HEAD');
  const a = await vscode.window.showInformationMessage(title, ...(oldHead ? ['Undo'] : []));
  if (a !== 'Undo' || !oldHead) return;
  if ((await revParse(repo, 'HEAD')) !== newHead) {
    void vscode.window.showErrorMessage(`Cannot undo: the repository has changed since "${title}"`);
    return;
  }
  const r = await repo.exec(['reset', '--keep', oldHead], { allowFailure: true });
  await repo.refresh();
  if (r.exitCode !== 0) showError(r.stderr, 'Undo failed');
}

/** Commits in the current branch only can be edited; checks it like GitCommitEditingActionBase. */
async function ensureInCurrentBranch(repo: Repository, hashes: string[], action: string) {
  if (repo.detectOperation() !== 'none') throw new Error(`Cannot ${action}: ${repo.detectOperation()} is in progress`);
  if (!repo.info.branch) throw new Error(`Cannot ${action} in detached HEAD state`);
  for (const h of hashes) if (!(await isAncestor(repo, h, 'HEAD'))) throw new Error(`The commit ${h.slice(0, 8)} is not in the current branch`);
  // Warn when the commits are already pushed (rewriting published history).
  const pushed = await repo.exec(['branch', '-r', '--contains', hashes[0]], { allowFailure: true, quiet: true });
  if (pushed.stdout.trim()) {
    const a = await vscode.window.showWarningMessage(
      `The commit ${hashes[0].slice(0, 8)} is already pushed to ${pushed.stdout.trim().split('\n')[0].trim()}. Rewriting it changes published history.`,
      { modal: true },
      capitalize(action),
    );
    if (!a) throw new CancelledError();
  }
}

// ------------------------------------------------------------------ in-log commit editing

export async function rewordCommand(ctx: Ctx, arg: CommitArg) {
  const repo = await repoFor(ctx, arg);
  const hash = await full(repo, arg.hash);
  await ensureInCurrentBranch(repo, [hash], 'edit commit message');
  const [c] = await commitMessages(repo, [hash]);
  const res = await showDialog<{ message: string }>(
    'ops.commitMessage',
    { title: 'Edit Commit Message', message: c.body, okLabel: 'OK', hint: `Edit message for commit ${hash.slice(0, 8)} by ${c.author}` },
    { title: 'Edit Commit Message' },
  );
  if (!res || res.message === c.body) return;
  const old = repo.info.headHash;
  const outcome = await withProgress('Editing commit message…', () => repo.batch(() => rewordCommit(repo, hash, res.message)), { location: 'window' });
  if (await reportOutcome(repo, outcome, { operation: 'reword', failedTitle: "Couldn't edit commit message" })) await notifyWithUndo(repo, 'Commit message changed', old);
}

export async function fixupCommand(ctx: Ctx, arg: CommitArg & { squash?: boolean }) {
  const repo = await repoFor(ctx, arg);
  const hash = await full(repo, arg.hash);
  await ensureInCurrentBranch(repo, [hash], arg.squash ? 'squash' : 'fixup');
  const staged = await repo.exec(['diff', '--cached', '--quiet'], { allowFailure: true, quiet: true });
  if (staged.exitCode === 0) {
    // IntelliJ opens the commit dialog with "fixup! subject"; here the staged area is used. Offer to stage tracked changes.
    const a = await vscode.window.showWarningMessage(
      `${arg.squash ? 'Squash Into' : 'Fixup'}: there are no staged changes. Stage all tracked changes and create the ${arg.squash ? 'squash!' : 'fixup!'} commit?`,
      { modal: true },
      'Stage All and Continue',
    );
    if (!a) return;
    await repo.exec(['add', '-u']);
  }
  const old = repo.info.headHash;
  const outcome = await withProgress('Rebasing…', () => repo.batch(() => fixupInto(repo, hash, !!arg.squash)), { location: 'window' });
  if (await reportOutcome(repo, outcome, { operation: 'rebase', failedTitle: 'Rebase failed' })) await notifyWithUndo(repo, arg.squash ? 'Commits Squashed' : 'Rebase successful', old);
}

export async function dropCommand(ctx: Ctx, arg: CommitsArg) {
  const repo = await repoFor(ctx, arg);
  const hashes = await Promise.all(arg.hashes.map(h => full(repo, h)));
  await ensureInCurrentBranch(repo, hashes, 'drop commits');
  const n = hashes.length;
  const a = await vscode.window.showWarningMessage(
    `Drop ${n === 1 ? 'Commit' : 'Commits'}`,
    { modal: true, detail: `Do you want to drop ${n} ${n === 1 ? 'commit' : 'commits'} from the ${repo.info.branch} branch?` },
    'Drop',
  );
  if (a !== 'Drop') return;
  const old = repo.info.headHash;
  const outcome = await withProgress('Dropping commits…', () => repo.batch(() => dropCommits(repo, hashes)), { location: 'window' });
  if (await reportOutcome(repo, outcome, { operation: 'rebase', failedTitle: "Couldn't drop commits" })) await notifyWithUndo(repo, `Dropped ${n} ${n === 1 ? 'commit' : 'commits'}`, old);
}

export async function squashCommand(ctx: Ctx, arg: CommitsArg) {
  const repo = await repoFor(ctx, arg);
  const hashes = await Promise.all(arg.hashes.map(h => full(repo, h)));
  if (hashes.length < 2) throw new Error('Select at least two commits to squash');
  await ensureInCurrentBranch(repo, hashes, 'squash commits');
  const msgs = await commitMessages(repo, hashes);
  const res = await showDialog<{ message: string }>(
    'ops.commitMessage',
    { title: 'Squashed Commit Message', message: prettySquash(msgs.map(m => m.body)), okLabel: 'OK', commits: msgs, hint: 'Edit message for squashed commit' },
    { title: 'Squashed Commit Message' },
  );
  if (!res) return;
  const old = repo.info.headHash;
  const outcome = await withProgress('Squashing commits…', () => repo.batch(() => squashCommits(repo, hashes, res.message)), { location: 'window' });
  if (await reportOutcome(repo, outcome, { operation: 'rebase', failedTitle: "Couldn't squash commits" })) await notifyWithUndo(repo, 'Commits Squashed', old);
}

/** Opens the Rebasing Commits dialog for base..HEAD and runs the rebase. */
async function runInteractiveDialog(ctx: Ctx, repo: Repository, base: string | undefined, opts: { baseArgs?: string[]; extraArgs?: string[] } = {}) {
  const commits = await loadRebaseCommits(repo, base);
  if (commits.length === 0) {
    void vscode.window.showInformationMessage(
      'Git Rebase: There are no commits to rebase because the current branch is directly below the base branch, or they point to the same commit (the \'noop\' situation).',
    );
    return;
  }
  const hasMerges = commits.some(c => c.parents.length > 1);
  const res = await showDialog<{ entries: RebaseEntry[] }>(
    'ops.interactiveRebase',
    { root: repo.root, commits: commits.filter(c => c.parents.length <= 1), base },
    {
      title: 'Rebasing Commits',
      handlers: {
        commitChanges: (p: { hashes: string[] }) => commitChanges(repo, p.hashes),
        showDiff: (p: { change: Change; hash: string }) => openChangeDiff(p.change, `${p.hash}^`, p.hash),
      },
    },
  );
  if (!res) return;
  const old = repo.info.headHash;
  const outcome = await withProgress('Rebasing…', () => repo.batch(() => interactiveRebase(repo, base, res.entries, { rebaseMerges: hasMerges, ...opts })), { location: 'window' });
  if (await reportOutcome(repo, outcome, { operation: 'rebase', failedTitle: 'Rebase failed' })) await notifyWithUndo(repo, `Rebase successful: Rebased ${currentName(repo)}`, old);
}

export async function interactiveRebaseCommand(ctx: Ctx, arg: CommitArg) {
  const repo = await repoFor(ctx, arg);
  const hash = await full(repo, arg.hash);
  await ensureInCurrentBranch(repo, [hash], 'rebase');
  await runInteractiveDialog(ctx, repo, await rebaseBaseFor(repo, hash));
}

export async function undoCommitCommand(ctx: Ctx, arg: CommitArg) {
  const repo = await repoFor(ctx, arg);
  const hash = await full(repo, arg.hash);
  if (hash !== repo.info.headHash) throw new Error('Cannot Undo Commit: The selected commit is not the last in the current branch');
  const parents = (await repo.execText(['rev-list', '--parents', '-n', '1', hash], { quiet: true })).trim().split(' ').slice(1);
  if (parents.length > 1) throw new Error('Cannot Undo Commit: Selected commit is a merge commit');
  const pushed = await repo.exec(['branch', '-r', '--contains', hash], { allowFailure: true, quiet: true });
  if (pushed.stdout.trim()) {
    const a = await vscode.window.showWarningMessage('Undo Commit', { modal: true, detail: `The commit is already pushed to ${pushed.stdout.trim().split('\n')[0].trim()}. Undo it anyway?` }, 'Undo Commit');
    if (!a) return;
  }
  const r = parents.length
    ? await withProgress('Undoing Last Commit…', () => repo.batch(() => repo.exec(['reset', '--soft', 'HEAD~1'])), { location: 'window' })
    : await repo.batch(() => repo.exec(['update-ref', '-d', 'HEAD']));
  void r;
  // Restore the message as a draft for the next commit (IntelliJ keeps it in the commit message field).
  const [c] = await commitMessages(repo, [hash]).catch(() => []);
  if (c) void vscode.commands.executeCommand('rebased.setCommitMessage', { root: repo.root, message: c.body }).then(undefined, () => undefined);
  void vscode.window.showInformationMessage('Undo commit successful');
}

export async function resetCommand(ctx: Ctx, arg?: RootArg & { hash?: string }) {
  const repo = await repoFor(ctx, arg);
  let commits: { hash: string; subject: string; author: string; repo: string }[] = [];
  if (arg?.hash) {
    const [c] = await commitMessages(repo, [await full(repo, arg.hash)]);
    commits = [{ hash: c.hash, subject: c.subject, author: c.author, repo: repo.name }];
  }
  const res = await showDialog<{ mode: string; target: string }>(
    'ops.reset',
    { commits: commits.length ? commits : [{ hash: 'HEAD', subject: '', author: '', repo: repo.name }], branch: currentName(repo), editable: !arg?.hash },
    {
      title: arg?.hash ? 'Git Reset' : 'Reset Head',
      validate: async (v: { target: string }) => ((await revParse(repo, v.target || 'HEAD')) ? true : 'The specified commit expression did not pass validation.'),
    },
  );
  if (!res) return;
  const target = arg?.hash ? commits[0].hash : res.target || 'HEAD';
  if (res.mode === 'hard' && (repo.status.changes.length > 0)) {
    const a = await vscode.window.showWarningMessage('Hard Reset', { modal: true, detail: 'Any local changes will be lost. Continue?' }, 'Hard Reset');
    if (!a) return;
  }
  await putLocalHistoryLabel(repo, 'Before Reset');
  const outcome = await withProgress('Git Reset', () => repo.batch(() => runConflictAware(repo, ['reset', `--${res.mode}`, target])), { location: 'window' });
  if (outcome.kind === 'success') void vscode.window.showInformationMessage('Reset successful');
  else await reportOutcome(repo, outcome, { operation: 'reset', failedTitle: 'Reset failed' });
}

// ------------------------------------------------------------------ cherry-pick / revert

export async function cherryPickCommand(ctx: Ctx, arg: CommitsArg) {
  const repo = await repoFor(ctx, arg);
  const hashes = await sortOldestFirst(repo, await Promise.all(arg.hashes.map(h => full(repo, h))));
  const outcome = await withSmartOperation(repo, 'cherry-pick', async force => {
    if (force) await repo.exec(['stash', 'push', '--include-untracked', '-m', 'Uncommitted changes before cherry-pick']);
    return runConflictAware(repo, ['cherry-pick', '--allow-empty', ...hashes]);
  });
  if (!outcome) return;
  const msgs = await commitMessages(repo, hashes).catch(() => []);
  const desc = msgs.map(m => `${m.hash.slice(0, 8)} ${m.subject}`).join(', ');
  if (outcome.kind === 'success') void vscode.window.showInformationMessage(`Cherry-pick successful: ${desc}`);
  else await reportOutcome(repo, outcome, { operation: 'cherry-pick', failedTitle: 'Cherry-pick failed' });
}

export async function revertCommand(ctx: Ctx, arg: CommitsArg) {
  const repo = await repoFor(ctx, arg);
  const hashes = (await sortOldestFirst(repo, await Promise.all(arg.hashes.map(h => full(repo, h))))).reverse();
  const outcome = await withSmartOperation(repo, 'revert', async () => {
    const args = ['revert', '--no-edit'];
    for (const h of hashes) {
      const parents = (await repo.execText(['rev-list', '--parents', '-n', '1', h], { quiet: true })).trim().split(' ').length - 1;
      if (parents > 1) {
        args.push('-m', '1');
        break;
      }
    }
    return runConflictAware(repo, [...args, ...hashes]);
  });
  if (!outcome) return;
  const msgs = await commitMessages(repo, hashes).catch(() => []);
  if (outcome.kind === 'success') void vscode.window.showInformationMessage(`Revert successful: ${msgs.map(m => `${m.hash.slice(0, 8)} ${m.subject}`).join(', ')}`);
  else await reportOutcome(repo, outcome, { operation: 'revert', failedTitle: 'Revert failed' });
}

// ------------------------------------------------------------------ ongoing operations

export async function abortCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const op = repo.detectOperation();
  if (op === 'none') {
    void vscode.window.showInformationMessage('There is no operation in progress');
    return;
  }
  const names: Record<string, string> = { rebase: 'Rebase', merge: 'Merge', 'cherry-pick': 'Cherry-Pick', revert: 'Revert', am: 'Apply Patch', bisect: 'Bisect' };
  const a = await vscode.window.showWarningMessage(`Abort ${names[op]}`, { modal: true, detail: `Abort ${op} in ${repo.name}?` }, 'Abort');
  if (a !== 'Abort') return;
  const args = op === 'bisect' ? ['bisect', 'reset'] : [op, '--abort'];
  const r = await repo.batch(() => repo.exec(args, { allowFailure: true }));
  if (r.exitCode === 0) void vscode.window.showInformationMessage(op === 'rebase' ? 'Abort rebase succeeded' : `${names[op]} aborted`);
  else showError(r.stderr, op === 'rebase' ? 'Abort rebase failed' : `Abort ${op} failed`);
}

export async function continueCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const op = repo.detectOperation();
  if (op === 'none') {
    void vscode.window.showInformationMessage('There is no operation in progress');
    return;
  }
  if (repo.status.conflicts.length) {
    const a = await vscode.window.showWarningMessage(`Cannot continue ${op}: there are unresolved conflicts`, 'Resolve conflicts…');
    if (a) void vscode.commands.executeCommand('rebased.resolveConflicts', { root: repo.root });
    return;
  }
  const args = op === 'merge' ? ['commit', '--no-edit'] : op === 'am' ? ['am', '--continue'] : [op, '--continue'];
  let outcome = await withProgress(
    op === 'rebase' ? 'Continue rebase…' : op === 'merge' ? 'Committing merge…' : `Continuing ${op}…`,
    () => repo.batch(() => runConflictAware(repo, args)),
    { location: 'window' },
  );
  if (outcome.kind === 'error' && /unstaged changes|You must edit all merge conflicts|needs merge|Changes not staged/.test(outcome.output)) {
    const a = await vscode.window.showWarningMessage(`Continue ${op} failed: There are unstaged changes in tracked files preventing ${op} from continuing`, 'Stage and Retry');
    if (a !== 'Stage and Retry') return;
    await repo.exec(['add', '-u']);
    outcome = await repo.batch(() => runConflictAware(repo, args));
  }
  const done = repo.detectOperation() === 'none';
  if (outcome.kind === 'success' && done) {
    void vscode.window.showInformationMessage(op === 'rebase' ? 'Rebase successful' : op === 'merge' ? 'Merge committed' : `${capitalize(op)} successful`);
    return;
  }
  await reportOutcome(repo, outcome, { operation: op, failedTitle: op === 'rebase' ? 'Continue rebase failed' : `Continue ${op} failed` });
}

export async function skipCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const op = repo.detectOperation();
  if (op !== 'rebase' && op !== 'cherry-pick' && op !== 'revert') throw new Error('There is no rebase in progress');
  const outcome = await withProgress('Skip commit during rebase…', () => repo.batch(() => runConflictAware(repo, [op, '--skip'])), { location: 'window' });
  if (outcome.kind === 'success' && repo.detectOperation() === 'none') void vscode.window.showInformationMessage(`${capitalize(op)} successful`);
  else if (outcome.kind !== 'success') await reportOutcome(repo, outcome, { operation: op });
}

// ------------------------------------------------------------------ merge / rebase dialogs

function branchItems(repo: Repository, filter?: Set<string>) {
  const items: { value: string; icon: string; group: string; hint?: string }[] = [];
  for (const r of repo.refs) {
    if (r.current) continue;
    if (filter && !filter.has(r.fullName)) continue;
    if (r.type === 'local') items.push({ value: r.name, icon: r.favorite ? 'nodes/star' : 'general/vcs', group: 'Local' });
  }
  for (const r of repo.refs) {
    if (filter && !filter.has(r.fullName)) continue;
    if (r.type === 'remote') items.push({ value: r.name, icon: r.favorite ? 'nodes/star' : 'general/vcs', group: 'Remote' });
  }
  return items;
}

function repoChoices(ctx: Ctx, repo: Repository, all: boolean) {
  return (all ? ctx.repos.repositories : [repo]).map(r => ({ root: r.root, name: r.name, branch: currentName(r) }));
}

export async function mergeCommand(ctx: Ctx, arg?: RootArg & { branch?: string }) {
  const repo = await repoFor(ctx, arg);
  const repos = arg?.root ? [repo] : ctx.repos.repositories;
  const branches: Record<string, unknown> = {};
  for (const r of repos) {
    const unmerged = await r.exec(['for-each-ref', '--no-merged=HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { allowFailure: true, quiet: true });
    const set = unmerged.exitCode === 0 ? new Set(unmerged.stdout.split('\n').filter(Boolean)) : undefined;
    branches[r.root] = branchItems(r, set);
  }
  const res = await showDialog<{ root: string; branch: string; options: string[]; message: string }>(
    'ops.merge',
    { repos: repoChoices(ctx, repo, !arg?.root), root: repo.root, branches, initialBranch: arg?.branch },
    { title: `Merge into ${currentName(repo)}` },
  );
  if (!res) return;
  const target = ctx.repos.get(res.root)!;
  await merge(target, res.branch, res.options, res.message);
}

export async function merge(repo: Repository, branch: string, options: string[] = [], message?: string) {
  const args = ['merge'];
  for (const o of options) {
    if (o === 'commit-msg') args.push('-m', message || `Merge branch '${branch}'`);
    else args.push(`--${o}`);
  }
  if (!options.includes('commit-msg')) args.push('--no-edit');
  args.push(branch);
  const before = repo.info.headHash;
  await putLocalHistoryLabel(repo, 'Before Merge');
  const outcome = await withSmartOperation(repo, 'merge', async force => {
    if (force) await repo.exec(['reset', '--hard']);
    return withProgress(`Merging ${branch}…`, () => repo.batch(() => runConflictAware(repo, args)), { location: 'window' });
  });
  if (!outcome) return;
  if (outcome.kind === 'success') {
    await repo.refresh();
    if (before === repo.info.headHash && !options.includes('squash') && !options.includes('no-commit')) {
      void vscode.window.showInformationMessage('Already up to date');
      return;
    }
    const isLocal = repo.refs.some(r => r.type === 'local' && r.name === branch);
    const a = await vscode.window.showInformationMessage(`Merged ${branch} to ${currentName(repo)}`, ...(isLocal ? [`Delete ${branch}`] : []));
    if (a) void vscode.commands.executeCommand('rebased.branch.delete', { root: repo.root, name: branch, type: 'local' });
    return;
  }
  await reportOutcome(repo, outcome, { operation: 'merge', failedTitle: `Could Not Merge ${branch}` });
}

export async function rebaseCommand(ctx: Ctx, arg?: RootArg & { upstream?: string }) {
  const repo = await repoFor(ctx, arg);
  const repos = arg?.root ? [repo] : ctx.repos.repositories;
  const refs: Record<string, unknown> = {};
  const locals: Record<string, unknown> = {};
  for (const r of repos) {
    refs[r.root] = [
      ...r.refs.filter(x => x.type === 'local' && !x.current).map(x => ({ value: x.name, icon: 'general/vcs', group: 'Local' })),
      ...r.refs.filter(x => x.type === 'remote').map(x => ({ value: x.name, icon: 'general/vcs', group: 'Remote' })),
      ...r.refs.filter(x => x.type === 'tag').map(x => ({ value: x.name, icon: 'nodes/tag', group: 'Tags' })),
    ];
    locals[r.root] = r.refs.filter(x => x.type === 'local').map(x => ({ value: x.name, icon: 'general/vcs' }));
  }
  const res = await showDialog<{ root: string; upstream: string; onto: string; branch: string; options: string[] }>(
    'ops.rebase',
    { repos: repoChoices(ctx, repo, !arg?.root), root: repo.root, refs, locals, initialUpstream: arg?.upstream ?? repo.info.upstream },
    {
      title: 'Rebase',
      validate: async (v: { root: string; upstream: string; onto: string; branch: string; options: string[] }) => {
        const r = ctx.repos.get(v.root)!;
        if (r.detectOperation() === 'rebase') return 'Interactive rebase is already in progress for this Git root';
        for (const ref of [v.upstream, v.onto, v.branch].filter(Boolean)) if (!(await revParse(r, ref))) return `There is no such branch or tag: ${ref}`;
        return true;
      },
    },
  );
  if (!res) return;
  const target = ctx.repos.get(res.root)!;
  const extra: string[] = [];
  for (const o of res.options) if (['update-refs', 'rebase-merges', 'keep-empty', 'autosquash'].includes(o)) extra.push(`--${o}`);
  const baseArgs: string[] = [];
  if (res.options.includes('onto')) baseArgs.push('--onto', res.onto);
  if (res.options.includes('root')) baseArgs.push('--root');
  else baseArgs.push(res.upstream);
  if (res.options.includes('switch') && res.branch) baseArgs.push(res.branch);
  if (res.options.includes('interactive')) {
    if (res.options.includes('switch') && res.branch) {
      const co = await target.exec(['checkout', res.branch], { allowFailure: true });
      if (co.exitCode !== 0) return showError(co.stderr, 'Rebase failed');
      baseArgs.pop();
    }
    const base = res.options.includes('root') ? undefined : (await target.execText(['merge-base', 'HEAD', res.upstream], { quiet: true })).trim();
    await runInteractiveDialog(ctx, target, base, { baseArgs, extraArgs: extra.filter(e => e !== '--rebase-merges') });
    return;
  }
  await rebase(target, [...extra, ...baseArgs], res.options.includes('switch') ? res.branch : currentName(target), res.options.includes('onto') ? res.onto : res.upstream);
}

export async function rebase(repo: Repository, args: string[], branch: string, onto: string) {
  await putLocalHistoryLabel(repo, 'Before Rebase');
  const outcome = await withProgress(`Rebasing onto ${onto}…`, () => repo.batch(() => runConflictAware(repo, ['rebase', '--autostash', ...args], { env: nonInteractiveEnv() })), { location: 'window' });
  if (outcome.kind === 'success') {
    void vscode.window.showInformationMessage(`Rebase successful: Rebased ${branch} on ${onto}`);
    return true;
  }
  return reportOutcome(repo, outcome, { operation: 'rebase', failedTitle: 'Rebase failed' });
}

// ------------------------------------------------------------------ tags

export async function createTagCommand(ctx: Ctx, arg?: RootArg & { hash?: string }) {
  const repo = await repoFor(ctx, arg);
  if (arg?.hash) {
    // From the log: simple input "Create New Tag On {0}".
    const name = await vscode.window.showInputBox({
      title: `Create New Tag On ${arg.hash.slice(0, 8)}`,
      prompt: 'Enter the name of new tag',
      validateInput: v => (!v.trim() ? undefined : repo.refs.some(r => r.type === 'tag' && r.name === v.trim()) ? 'The tag with the same name exists.' : /[\s~^:?*[\\]|\.\.|@\{/.test(v) ? `Tag name ${v} is not valid` : undefined),
    });
    if (!name?.trim()) return;
    await repo.exec(['tag', name.trim(), arg.hash]);
    await repo.refresh();
    void vscode.window.showInformationMessage(`Created tag ${name.trim()} successfully.`);
    return;
  }
  await showDialog('ops.tag', { root: repo.root, repoName: repo.name, currentBranch: currentName(repo), tags: repo.refs.filter(r => r.type === 'tag').map(r => r.name) }, {
    title: 'Tag',
    validate: async (v: { name: string; force: boolean; commit: string; message: string }) => {
      if (v.commit && !(await revParse(repo, v.commit))) return 'The commit or object name is invalid.';
      const args = ['tag'];
      if (v.force) args.push('-f');
      if (v.message.trim()) {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rebased-tag-')), 'msg');
        fs.writeFileSync(f, v.message);
        args.push('-a', '-F', f);
      }
      args.push(v.name);
      if (v.commit) args.push(v.commit);
      const r = await repo.exec(args, { allowFailure: true });
      if (r.exitCode !== 0) return r.stderr.trim();
      await repo.refresh();
      void vscode.window.showInformationMessage(`Created tag ${v.name} successfully.`);
      return true;
    },
  });
}

// ------------------------------------------------------------------ patches

export async function createPatchCommand(ctx: Ctx, arg?: RootArg & { hashes?: string[]; changes?: Change[] }) {
  const repo = await repoFor(ctx, arg);
  const count = arg?.changes?.length ?? arg?.hashes?.length ?? repo.status.changes.length;
  const defaultPath = path.join(repo.root, arg?.hashes?.length === 1 ? `${arg.hashes[0].slice(0, 8)}.patch` : 'changes.patch');
  const res = await showDialog<{ path: string; reverse: boolean; clipboard: boolean }>(
    'ops.createPatch',
    { path: defaultPath, count },
    {
      title: 'Create Patch',
      handlers: {
        browse: async (current: string) => {
          const r = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(current), title: 'Save Patch to', filters: { Patch: ['patch', 'diff'] } });
          return r?.fsPath ?? null;
        },
      },
    },
  );
  if (!res) return;
  const args: string[] = [];
  const paths = arg?.changes?.flatMap(c => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
  if (arg?.hashes?.length) {
    const sorted = await sortOldestFirst(repo, arg.hashes);
    if (sorted.length === 1) args.push('show', '--format=email', '--binary', ...(res.reverse ? ['-R'] : []), sorted[0]);
    else {
      const first = await repo.exec(['rev-parse', '-q', '--verify', `${sorted[0]}^`], { allowFailure: true, quiet: true });
      args.push('diff', '--binary', ...(res.reverse ? ['-R'] : []), first.exitCode === 0 ? first.stdout.trim() : '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sorted[sorted.length - 1]);
    }
  } else args.push('diff', 'HEAD', '--binary', ...(res.reverse ? ['-R'] : []));
  if (paths?.length) args.push('--', ...paths);
  const patch = await repo.execText(args, { quiet: true });
  if (res.clipboard) {
    await vscode.env.clipboard.writeText(patch);
    void vscode.window.showInformationMessage('Patch copied to clipboard');
  } else {
    fs.writeFileSync(res.path, patch);
    const a = await vscode.window.showInformationMessage(`Successfully created patch ${path.basename(res.path)}`, 'Open');
    if (a) void vscode.window.showTextDocument(vscode.Uri.file(res.path));
  }
}

export async function applyPatchCommand(ctx: Ctx, arg?: RootArg & { clipboard?: boolean; file?: string }) {
  const repo = await repoFor(ctx, arg);
  let input: string;
  if (arg?.clipboard) input = await vscode.env.clipboard.readText();
  else {
    const file = arg?.file ?? (await vscode.window.showOpenDialog({ title: 'Apply Patch', canSelectMany: false, filters: { Patch: ['patch', 'diff'], All: ['*'] }, defaultUri: vscode.Uri.file(repo.root) }))?.[0]?.fsPath;
    if (!file) return;
    input = fs.readFileSync(file, 'utf8');
  }
  if (!input.trim()) throw new Error('The patch is empty');
  const check = await repo.exec(['apply', '--check', '-'], { input, allowFailure: true });
  const args = check.exitCode === 0 ? ['apply', '-'] : ['apply', '--3way', '-'];
  const r = await repo.batch(() => repo.exec(args, { input, allowFailure: true }));
  if (r.exitCode === 0) void vscode.window.showInformationMessage('Patch applied');
  else if (/conflict/i.test(r.stderr)) {
    void vscode.commands.executeCommand('rebased.resolveConflicts', { root: repo.root }).then(undefined, () => undefined);
    void vscode.window.showWarningMessage('Patch applied with conflicts');
  } else showError(r.stderr, 'Patch was not applied');
}

// ------------------------------------------------------------------ checkout revision

export async function checkoutRevisionCommand(ctx: Ctx, arg: CommitArg) {
  const repo = await repoFor(ctx, arg);
  const outcome = await withSmartOperation(repo, 'checkout', force => repo.batch(() => runConflictAware(repo, ['checkout', ...(force ? ['--force'] : []), arg.hash, '--'])));
  if (!outcome) return;
  if (outcome.kind === 'success') void vscode.window.showInformationMessage(`Checked out ${arg.hash.slice(0, 8)}`);
  else await reportOutcome(repo, outcome, { operation: 'checkout', failedTitle: `Could not checkout ${arg.hash.slice(0, 8)}` });
}

export type { OperationOutcome };
