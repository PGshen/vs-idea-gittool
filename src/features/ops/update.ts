import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { withProgress } from '../../host/ui';
import { currentName, makeSaver, putLocalHistoryLabel, repoFor, reportOutcome, reportRestore, RootArg, settings, withSmartOperation } from './common';
import { ChangesSaver, OperationOutcome, resetToRemoteBranch, updateForcePushedBranch, updateRepository, UpdateMethod, UpdateResult, updateSummary } from './engine';

type UpdateDialogResult = { method: UpdateMethod; saveChanges: string; dontShow: boolean; button?: 'reset' };

/** Update method of one repository: the chosen one, or the per-branch git config for "Branch Default". */
async function methodFor(repo: Repository, method: UpdateMethod): Promise<UpdateMethod> {
  if (settings().get<string>('updateMethod') !== 'branchDefault') return method;
  const cfg = (await repo.getConfig(`branch.${repo.info.branch}.rebase`)) ?? (await repo.getConfig('pull.rebase'));
  return cfg === 'true' || cfg === 'merges' || cfg === 'interactive' ? 'rebase' : 'merge';
}

/**
 * Runs Update Project for one repository with the configured "Clean working tree using Stash / Shelve"
 * policy and reports problems with restoring local changes. Used by Update Project and by the push-rejected flow.
 */
export async function updateWithSavedChanges(
  repo: Repository,
  method: UpdateMethod,
  opts: { progress?: (t: string) => void; token?: vscode.CancellationToken; saver?: ChangesSaver } = {},
): Promise<UpdateResult & { saver: ChangesSaver }> {
  const saver = opts.saver ?? makeSaver();
  await putLocalHistoryLabel(repo, 'Before Update');
  const res = await repo.batch(() => updateRepository(repo, method, { progress: opts.progress, token: opts.token, saver }));
  return { ...res, saver };
}

/** `ideagittool.updateProject {root?, method?}`: VcsUpdateDialog + GitUpdateProcess. */
export async function updateProjectCommand(ctx: Ctx, arg?: RootArg & { method?: UpdateMethod }) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  if (repos.length === 0) throw new Error('No Git repository found in the workspace.');
  let method: UpdateMethod = arg?.method ?? (settings().get<string>('updateMethod', 'merge') === 'rebase' ? 'rebase' : 'merge');
  if (!arg?.method && settings().get<boolean>('update.showDialog', true)) {
    const r = await showDialog<UpdateDialogResult>(
      'ops.update',
      { method, saveChanges: settings().get('update.saveChangesPolicy', 'stash'), repos: repos.map(r => r.name), canReset: repos.length === 1 },
      { title: 'Update Project' },
    );
    if (!r) return;
    if (r.button === 'reset') return resetToRemoteCommand(ctx, { root: repos[0].root });
    method = r.method;
    await settings().update('updateMethod', r.method, vscode.ConfigurationTarget.Global);
    await settings().update('update.saveChangesPolicy', r.saveChanges, vscode.ConfigurationTarget.Global);
    if (r.dontShow) await settings().update('update.showDialog', false, vscode.ConfigurationTarget.Global);
  }
  for (const repo of repos) {
    if (repo.detectOperation() !== 'none' || repo.status.conflicts.length) {
      void vscode.window.showErrorMessage(
        repo.detectOperation() === 'rebase'
          ? "Can't update: You have unfinished rebase process. These conflicts must be resolved before update."
          : "Can't update: Unmerged files detected. These conflicts must be resolved before update.",
      );
      return;
    }
  }
  const results: { repo: Repository; res: UpdateResult & { saver: ChangesSaver } }[] = [];
  await withProgress(
    'Updating…',
    async (progress, token) => {
      for (const repo of repos) {
        const m = await methodFor(repo, method);
        results.push({ repo, res: await updateWithSavedChanges(repo, m, { progress: t => progress(repos.length > 1 ? `${repo.name}: ${t}` : t), token }) });
      }
    },
    { cancellable: true },
  );
  const skipped = results.filter(r => r.res.outcome.kind === 'skipped');
  const failed = results.filter(r => r.res.outcome.kind !== 'success' && r.res.outcome.kind !== 'skipped');
  // Conflicts of the update are resolved first, then the restored local changes are reported (GitUpdateProcess).
  for (const f of failed) await reportOutcome(f.repo, f.res.outcome as OperationOutcome, { operation: 'update', failedTitle: 'Update failed' });
  for (const { repo, res } of results) {
    if (res.outcome.kind !== 'skipped') await reportRestore(repo, res.saver, 'update', res.restore, res.savedChangesKept ?? false);
  }
  // The tracked branch was force-pushed: offer IntelliJ's "Update Force-Pushed Branch".
  for (const { repo, res } of results) {
    if (!res.forcePushed) continue;
    void vscode.window
      .showWarningMessage(
        `${res.forcePushed.upstream} was force-pushed: the tracked branch was rewritten on the remote. Update the current branch by resetting it to ${res.forcePushed.upstream} and cherry-picking the local commits?`,
        'Update Force-Pushed Branch',
      )
      .then(a => a && vscode.commands.executeCommand('ideagittool.updateForcePushedBranch', { root: repo.root }));
  }
  if (failed.length) return;
  if (skipped.length === results.length) {
    const reason = (skipped[0].res.outcome as { reason: string }).reason;
    const name = currentName(skipped[0].repo);
    void vscode.window.showWarningMessage(
      reason === 'detached HEAD'
        ? "Can't update: no current branch. You are in 'detached HEAD' state, which means that you're not on any branch. Checkout a branch to make update possible."
        : `Can't update: no tracked branch. No tracked branch configured for branch ${name} or the branch doesn't exist. To make your branch track a remote branch call, for example, git branch --set-upstream-to=origin/${name} ${name}`,
    );
    return;
  }
  const commits = results.reduce((s, r) => s + r.res.commits, 0);
  const files = results.reduce((s, r) => s + r.res.files, 0);
  const title = skipped.length ? 'Project Partially Updated' : 'Project updated';
  const skippedText = skipped.length
    ? ` Skipped ${skipped.length} ${skipped.length === 1 ? 'repository' : 'repositories'}: ${skipped.map(s => `${s.repo.name} was skipped (${(s.res.outcome as { reason: string }).reason})`).join(', ')}`
    : '';
  if (commits === 0) {
    void vscode.window.showInformationMessage(`All files are up-to-date${skippedText}`);
    return;
  }
  const first = results.find(r => r.res.commits > 0)!;
  const a = await vscode.window.showInformationMessage(`${title}: ${updateSummary(files, commits)}${skippedText}`, 'View Commits');
  if (a) void vscode.commands.executeCommand('ideagittool.compareRefs', { root: first.repo.root, ref: first.res.after, with: first.res.before });
}

/** "Reset to the Remote Branch" (left button of the Update dialog). */
export async function resetToRemoteCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const branch = repo.info.branch;
  if (!branch) {
    void vscode.window.showErrorMessage("Can't update: no current branch. You are in 'detached HEAD' state, which means that you're not on any branch. Checkout a branch to make update possible.");
    return;
  }
  const upstream = repo.currentBranchRef?.upstream;
  if (!upstream) {
    void vscode.window.showErrorMessage(
      `Can't update: no tracked branch. No tracked branch configured for branch ${branch} or the branch doesn't exist. To make your branch track a remote branch call, for example, git branch --set-upstream-to=origin/${branch} ${branch}`,
    );
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    'Reset to the Remote Branch',
    { modal: true, detail: `Do you want to reset local branch ${branch} to ${upstream}? Local commits will be dropped` },
    'OK',
  );
  if (ok !== 'OK') return;
  await putLocalHistoryLabel(repo, 'Before Update');
  let res: Awaited<ReturnType<typeof resetToRemoteBranch>> | undefined;
  const outcome = await withSmartOperation(
    repo,
    'checkout',
    async force => {
      res = await withProgress('Updating…', (progress, token) => repo.batch(() => resetToRemoteBranch(repo, { progress, token, force })));
      return res.outcome.kind === 'skipped' ? { kind: 'success', output: '' } : res.outcome;
    },
    { destination: upstream },
  );
  if (!outcome || !res) return;
  if (outcome.kind !== 'success') {
    await reportOutcome(repo, outcome, { operation: 'update', failedTitle: 'Update failed' });
    return;
  }
  void vscode.window.showInformationMessage(res.before === res.after ? 'All files are up-to-date' : `Project updated: ${branch} was reset to ${upstream}`);
}

/** `ideagittool.updateForcePushedBranch {root?}`: IntelliJ's "Update Force-Pushed Branch". */
export async function updateForcePushedBranchCommand(ctx: Ctx, arg?: RootArg) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  const method: UpdateMethod = settings().get<string>('updateMethod', 'merge') === 'rebase' ? 'rebase' : 'merge';
  let anyError = false;
  await withProgress('Performing force-pushed branch update…', async (progress, token) => {
    for (const repo of repos) {
      if (repo.detectOperation() !== 'none' || repo.status.conflicts.length) {
        void vscode.window.showErrorMessage("Can't update: Unmerged files detected. These conflicts must be resolved before update.");
        anyError = true;
        continue;
      }
      const saver = makeSaver();
      await putLocalHistoryLabel(repo, 'Before Update');
      const m = await methodFor(repo, method);
      const r = await repo.batch(() => updateForcePushedBranch(repo, { progress, token, saver, method: m }));
      if (r.result === 'regular' && r.update) {
        if (r.update.outcome.kind !== 'success' && r.update.outcome.kind !== 'skipped') {
          anyError = true;
          await reportOutcome(repo, r.update.outcome, { operation: 'update', failedTitle: 'Update failed' });
        }
        await reportRestore(repo, saver, 'update', r.update.restore, r.update.savedChangesKept ?? false);
      } else if (r.result === 'incomplete') {
        anyError = true;
        void vscode.window.showWarningMessage(`Not all local commits were cherry-picked from ${r.backup} branch`);
        if (r.cherryPick && r.cherryPick.kind !== 'success') await reportOutcome(repo, r.cherryPick, { operation: 'cherry-pick' });
      } else if (r.result === 'error') {
        anyError = true;
        await reportOutcome(repo, { kind: 'error', output: '', error: r.error! }, { operation: 'update', failedTitle: 'Update failed' });
      } else if (r.restore) {
        await reportRestore(repo, saver, 'update', r.restore, r.restore.kind === 'error');
      }
    }
  });
  if (!anyError) void vscode.window.showInformationMessage('Update of possible force-pushed branch was successful');
}
