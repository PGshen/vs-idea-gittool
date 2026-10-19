import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { CancelledError, showError } from '../../host/webviewHost';
import { GitError } from '../../git/exec';
import { ChangesSaver, hasLocalChanges, OperationOutcome, smartOperation, StashSaver } from './engine';

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
  texts: { operation: string; success?: string; successTitle?: string; failedTitle?: string; noCommit?: boolean },
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
      if (a === 'Continue') await vscode.commands.executeCommand('ideagittool.continueOperation', { root: repo.root });
      else if (a === 'Abort') await vscode.commands.executeCommand('ideagittool.abortOperation', { root: repo.root });
      return false;
    }
    case 'conflicts': {
      if (outcome.handled) return false;
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
      // GitConflictResolver: the Conflicts dialog opens right away; the notification only tells about conflicts
      // left when it is closed (notifyUnresolvedRemain).
      const result = await resolveConflicts(repo);
      const op2 = repo.detectOperation();
      if (!result.remaining) {
        // proceedAfterAllMerged: IntelliJ commits the merge and continues the rebase; cherry-pick and revert
        // wait for the commit of the resolved changes.
        if (op2 === 'merge' && !texts.noCommit || op2 === 'rebase') await vscode.commands.executeCommand('ideagittool.continueOperation', { root: repo.root });
        else if (op2 === 'cherry-pick' || op2 === 'revert') {
          const label = `Continue ${op2 === 'cherry-pick' ? 'Cherry-Pick' : 'Revert'}`;
          const a = await vscode.window.showInformationMessage('All conflicts have been resolved', label);
          if (a === label) await vscode.commands.executeCommand('ideagittool.continueOperation', { root: repo.root });
        }
        return false;
      }
      const actions = op2 !== 'none' ? ['Resolve…', `Abort ${capitalize(op2 === 'cherry-pick' ? 'Cherry-Pick' : op2)}`] : ['Resolve…'];
      const a = await vscode.window.showWarningMessage(`${title}: There are pending unresolved conflicts.`, ...actions);
      if (a === 'Resolve…') void vscode.commands.executeCommand('ideagittool.resolveConflicts', { root: repo.root });
      else if (a?.startsWith('Abort')) await vscode.commands.executeCommand('ideagittool.abortOperation', { root: repo.root });
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

/** Opens the Conflicts dialog of the commit feature and waits until it is closed. */
async function resolveConflicts(repo: Repository, context?: unknown): Promise<{ remaining: number }> {
  try {
    const r = await vscode.commands.executeCommand<{ remaining?: number } | undefined>('ideagittool.resolveConflicts', { root: repo.root, context });
    if (typeof r?.remaining === 'number') return { remaining: r.remaining };
  } catch {
    // The commit feature is not available: report the conflicts.
  }
  await repo.refresh();
  return { remaining: repo.status.conflicts.length };
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Runs an operation that can be blocked by local changes. When git refuses, shows the
 * "Git Checkout Problem" dialog (Smart Checkout / Force Checkout / Don't Checkout).
 * `destination` names what the operation brings in (the branch merged or checked out), for the conflicts of the
 * restored changes: "Uncommitted changes that were saved before merge have conflicts with files from feature".
 * Conflicts already shown to the user come back with `handled` set.
 */
export async function withSmartOperation(
  repo: Repository,
  operation: string,
  run: (force: boolean) => Promise<OperationOutcome>,
  opts: { destination?: string; noCommit?: boolean } = {},
): Promise<OperationOutcome | undefined> {
  const { destination } = opts;
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
  // Smart Checkout / Smart Merge save the changes with the configured policy (stash or shelve).
  const saver = makeSaver(undefined, true);
  const outcome = await smartOperation(repo, () => run(false), operation, saver);
  if (outcome.kind !== 'conflicts') return outcome;
  if (outcome.savedChangesKept) {
    // The operation stopped with conflicts: resolve them first; once it is finished the saved changes are restored.
    await reportOutcome(repo, outcome, { operation, noCommit: opts.noCommit });
    await repo.refresh();
    if (repo.detectOperation() === 'none' && !repo.status.conflicts.length) {
      const restored = await saver.restore(repo);
      await reportRestore(repo, saver, operation, restored, restored.kind === 'error', destination);
    } else {
      await reportRestore(repo, saver, operation, undefined, true);
    }
  } else {
    await reportRestore(repo, saver, operation, outcome, false, destination);
  }
  return { ...outcome, handled: true };
}

export function remoteOf(repo: Repository, remoteBranch: string): string | undefined {
  return repo.remotes.map(r => r.name).sort((a, b) => b.length - a.length).find(r => remoteBranch.startsWith(r + '/'));
}

/** Upstream short name (origin/master) for a local branch. */
export function upstreamOf(repo: Repository, branch: string): string | undefined {
  return repo.refs.find(r => r.type === 'local' && r.name === branch)?.upstream;
}

export function settings() {
  return vscode.workspace.getConfiguration('ideagittool');
}

// ------------------------------------------------------------------ preserving local changes

/**
 * Shelf-based saver: uses the commit feature's shelf (`ideagittool.shelveSilently {root, name}` → shelf id,
 * `ideagittool.unshelveSilently {id}` → {ok, conflicts}). Falls back to the stash when the shelf commands fail.
 */
export class ShelveSaver implements ChangesSaver {
  method: 'stash' | 'shelve' = 'shelve';
  private id: string | undefined;
  private fallback: StashSaver | undefined;

  constructor(private readonly includeUntracked: boolean) {}

  async save(repo: Repository, reason: string): Promise<boolean> {
    const name = `Uncommitted changes before ${capitalize(reason)} at ${new Date().toLocaleString()}`;
    if (!(await hasLocalChanges(repo, this.includeUntracked))) return false;
    try {
      const id = await vscode.commands.executeCommand<string | undefined>('ideagittool.shelveSilently', { root: repo.root, name });
      this.id = typeof id === 'string' ? id : undefined;
      await repo.refresh();
      return !!this.id;
    } catch {
      this.method = 'stash';
      this.fallback = new StashSaver(this.includeUntracked);
      return this.fallback.save(repo, reason);
    }
  }

  async restore(repo: Repository): Promise<OperationOutcome> {
    if (this.fallback) return this.fallback.restore(repo);
    try {
      const r = await vscode.commands.executeCommand<{ ok: boolean; conflicts?: string[] | number } | undefined>('ideagittool.unshelveSilently', { id: this.id, root: repo.root });
      await repo.refresh();
      if (r?.ok) return { kind: 'success', output: '' };
      const files = Array.isArray(r?.conflicts) ? r!.conflicts : repo.status.conflicts.map(c => c.path);
      if (files.length || r?.conflicts) return { kind: 'conflicts', output: '', files };
      return { kind: 'error', output: '', error: new GitError('Could not unshelve local changes', ['unshelve'], 1, '', '') };
    } catch (e) {
      return { kind: 'error', output: '', error: new GitError(e instanceof Error ? e.message : String(e), ['unshelve'], 1, '', '') };
    }
  }
}

/** Saver for the "Clean working tree using Stash / Shelve" policy (ideagittool.update.saveChangesPolicy). */
export function makeSaver(policy?: string, includeUntracked = false): ChangesSaver {
  const p = policy ?? settings().get<string>('update.saveChangesPolicy', 'stash');
  return p === 'shelve' ? new ShelveSaver(includeUntracked) : new StashSaver(includeUntracked);
}

/**
 * Context of the Conflicts dialog for local changes restored with conflicts (GitPreservingProcess with
 * GitConflictResolver.Params.setReverse(true)): the saved changes are "Yours", the result of the operation "Theirs".
 */
export function restoreConflictContext(method: 'stash' | 'shelve', operation: string, destination: string) {
  return {
    description: `Uncommitted changes that were saved before ${operation} have conflicts with files from ${destination}`,
    left: [{ text: `Uncommitted changes from the ${method === 'shelve' ? 'shelf' : 'stash'}` }],
    right: [{ text: 'Changes from ' }, { text: destination, bold: true }],
    reverse: true,
  };
}

/**
 * Local changes that could not be restored after an operation (GitPreservingProcess). Conflicts open the
 * Conflicts dialog right away; "Local changes were restored with conflicts" is shown when some are left, and
 * "Local changes were not restored" when the changes stayed saved. Like IntelliJ, the stash / shelf is kept.
 */
export async function reportRestore(repo: Repository, saver: ChangesSaver, operation: string, restore: OperationOutcome | undefined, kept: boolean, destination?: string) {
  const where = saver.method === 'shelve' ? 'shelf' : 'stash';
  const view = () => vscode.commands.executeCommand(saver.method === 'shelve' ? 'ideagittool.showShelf' : 'ideagittool.showStashes', { root: repo.root });
  if (restore?.kind === 'conflicts') {
    // IntelliJ names the update "Update" and what it brings "Remote" (GitUpdateProcess).
    const op = operation === 'update' ? 'Update' : operation;
    const dest = destination ?? (operation === 'update' ? 'Remote' : currentName(repo));
    const { remaining } = await resolveConflicts(repo, restoreConflictContext(saver.method, op, dest));
    if (!remaining) return;
    const a = await vscode.window.showWarningMessage(
      `Local changes were restored with conflicts: Your uncommitted changes were saved to ${where}. ${saver.method === 'shelve' ? 'Unshelve' : 'Unstash'} is not complete, you have unresolved merges in your working tree. Resolve conflicts and ${saver.method === 'shelve' ? 'remove the shelved changes' : 'drop the stash'}.`,
      'Resolve conflicts…',
      'View saved changes…',
    );
    if (a === 'Resolve conflicts…') void vscode.commands.executeCommand('ideagittool.resolveConflicts', { root: repo.root });
    else if (a) await view();
  } else if (kept) {
    const a = await vscode.window.showWarningMessage(`Local changes were not restored: Before ${operation} your uncommitted changes were saved to ${where}.`, 'View saved changes…');
    if (a) await view();
  }
}

/** Puts a system label into Local History before a working tree change (best effort). */
export async function putLocalHistoryLabel(repo: Repository, label: string) {
  try {
    await vscode.commands.executeCommand('ideagittool.localHistory.putSystemLabel', { root: repo.root, label });
  } catch {
    // Local History is optional.
  }
}

/** The repository Git actions without an explicit root work on: the one of the active editor, else the first. */
export function activeRepo(ctx: Ctx): Repository | undefined {
  const doc = vscode.window.activeTextEditor?.document.uri;
  if (doc?.scheme === 'file') {
    const r = ctx.repos.getForFile(doc.fsPath);
    if (r) return r;
  }
  return ctx.repos.repositories[0];
}
