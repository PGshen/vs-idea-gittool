import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { CancelledError, showError } from '../../host/webviewHost';
import { OperationOutcome, smartOperation } from './engine';

export interface RootArg {
  root?: string;
}

/** Resolves the repository of a command argument (`{root}`, a URI, or the picker). */
export async function repoFor(ctx: Ctx, arg?: RootArg | vscode.Uri | unknown, placeHolder?: string): Promise<Repository> {
  await ctx.repos.ready();
  if (arg instanceof vscode.Uri) {
    const r = ctx.repos.getForFile(arg.fsPath);
    if (r) return r;
  } else if (arg && typeof arg === 'object' && 'root' in arg && typeof (arg as RootArg).root === 'string') {
    const r = ctx.repos.get((arg as RootArg).root!) ?? (await ctx.repos.open((arg as RootArg).root!));
    if (r) return r;
  } else if (arg && typeof arg === 'object' && 'rootUri' in arg) {
    // SourceControl argument from the SCM view.
    const r = ctx.repos.getForFile((arg as { rootUri: vscode.Uri }).rootUri.fsPath);
    if (r) return r;
  }
  const r = await ctx.repos.pick(placeHolder);
  if (!r) throw new CancelledError();
  return r;
}

export function shortRef(ref: string) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref.replace(/^refs\/(heads|remotes|tags)\//, '');
}

/** Name of the current branch, or the short hash in detached HEAD. */
export function currentName(repo: Repository) {
  return repo.info.branch ?? (repo.info.headHash ? repo.info.headHash.slice(0, 8) : 'HEAD');
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Notifications for an operation that may stop with conflicts, like GitConflictResolver / GitRebaseProcess. */
export async function reportOutcome(
  repo: Repository,
  outcome: OperationOutcome,
  texts: { operation: string; success?: string; successTitle?: string; failedTitle?: string },
): Promise<boolean> {
  await repo.refresh();
  const name = texts.operation;
  switch (outcome.kind) {
    case 'success':
      if (texts.success !== undefined || texts.successTitle) {
        void vscode.window.showInformationMessage([texts.successTitle, texts.success].filter(Boolean).join(': '));
      }
      return true;
    case 'stopped': {
      const a = await vscode.window.showInformationMessage('Rebase stopped for editing', 'Continue', 'Abort');
      if (a === 'Continue') await vscode.commands.executeCommand('rebased.continueOperation', { root: repo.root });
      else if (a === 'Abort') await vscode.commands.executeCommand('rebased.abortOperation', { root: repo.root });
      return false;
    }
    case 'conflicts': {
      const op = repo.detectOperation();
      const title =
        op === 'rebase'
          ? 'Rebase stopped due to conflicts'
          : op === 'cherry-pick'
            ? 'Cherry-pick was performed with conflicts'
            : op === 'revert'
              ? 'Revert was performed with conflicts'
              : op === 'merge'
                ? 'Merge conflicts'
                : `${capitalize(name)} was performed with conflicts`;
      void vscode.commands.executeCommand('rebased.resolveConflicts', { root: repo.root });
      const actions = op !== 'none' ? ['Resolve conflicts…', `Abort ${capitalize(op === 'cherry-pick' ? 'Cherry-Pick' : op)}`] : ['Resolve conflicts…'];
      const a = await vscode.window.showWarningMessage(`${title}${outcome.files.length ? `: ${outcome.files.length} conflicting ${outcome.files.length === 1 ? 'file' : 'files'}` : ''}`, ...actions);
      if (a === 'Resolve conflicts…') await vscode.commands.executeCommand('rebased.resolveConflicts', { root: repo.root });
      else if (a?.startsWith('Abort')) await vscode.commands.executeCommand('rebased.abortOperation', { root: repo.root });
      return false;
    }
    case 'localChanges':
      void vscode.window.showErrorMessage(
        `${texts.failedTitle ?? `${capitalize(name)} failed`}: your local changes to the following files would be overwritten by ${name}: ${outcome.files.join(', ')}`,
      );
      return false;
    case 'error':
      showError(outcome.error, texts.failedTitle ?? `${capitalize(name)} failed`);
      return false;
  }
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Runs an operation that can be blocked by local changes. When git refuses, shows the
 * "Git Checkout Problem" dialog (Smart Checkout / Force Checkout / Don't Checkout).
 */
export async function withSmartOperation(
  repo: Repository,
  operation: string,
  run: (force: boolean) => Promise<OperationOutcome>,
): Promise<OperationOutcome | undefined> {
  const first = await run(false);
  if (first.kind !== 'localChanges') return first;
  const cap = capitalize(operation);
  const choice = await showDialog<{ button: string }>(
    'ops.smartOperation',
    { operation, files: first.files, untracked: first.untracked, root: repo.root },
    { title: `Git ${cap} Problem` },
  );
  if (!choice || choice.button === 'dont') return undefined;
  if (choice.button === 'force') return run(true);
  return smartOperation(repo, () => run(false), operation);
}

export function remoteOf(repo: Repository, remoteBranch: string): string | undefined {
  return repo.remotes.map(r => r.name).sort((a, b) => b.length - a.length).find(r => remoteBranch.startsWith(r + '/'));
}

/** Upstream short name (origin/master) for a local branch. */
export function upstreamOf(repo: Repository, branch: string): string | undefined {
  return repo.refs.find(r => r.type === 'local' && r.name === branch)?.upstream;
}

export function settings() {
  return vscode.workspace.getConfiguration('rebased');
}
