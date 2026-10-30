import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { withProgress } from '../../host/ui';
import { currentName, makeSaver, putLocalHistoryLabel, repoFor, reportOutcome, reportRestore, RootArg, settings, withSmartOperation } from './common';
import { ChangesSaver, OperationOutcome, resetToRemoteBranch, updateForcePushedBranch, updateRepository, UpdateMethod, UpdateResult, updateSummary } from './engine';

/** Text of a skip reason of updateRepository ('detached HEAD', 'no tracked branch'). */
function skipReason(reason: string): string {
  return reason === 'detached HEAD' ? translate('detached HEAD') : reason === 'no tracked branch' ? translate('no tracked branch') : reason;
}

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
  await putLocalHistoryLabel(repo, translate('Before Update'));
  const res = await repo.batch(() => updateRepository(repo, method, { progress: opts.progress, token: opts.token, saver }));
  return { ...res, saver };
}

/** `ideagittool.updateProject {root?, method?}`: VcsUpdateDialog + GitUpdateProcess. */
export async function updateProjectCommand(ctx: Ctx, arg?: RootArg & { method?: UpdateMethod }) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  if (repos.length === 0) throw new Error(translate('No Git repository found in the workspace.'));
  let method: UpdateMethod = arg?.method ?? (settings().get<string>('updateMethod', 'merge') === 'rebase' ? 'rebase' : 'merge');
  if (!arg?.method && settings().get<boolean>('update.showDialog', true)) {
    const r = await showDialog<UpdateDialogResult>(
      'ops.update',
      { method, saveChanges: settings().get('update.saveChangesPolicy', 'stash'), repos: repos.map(r => r.name), canReset: repos.length === 1 },
      { title: translate('Update Project') },
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
          ? translate("Can't update: You have unfinished rebase process. These conflicts must be resolved before update.")
          : translate("Can't update: Unmerged files detected. These conflicts must be resolved before update."),
      );
      return;
    }
  }
  const results: { repo: Repository; res: UpdateResult & { saver: ChangesSaver } }[] = [];
  await withProgress(
    translate('Updating…'),
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
  for (const f of failed) await reportOutcome(f.repo, f.res.outcome as OperationOutcome, { operation: 'update', failedTitle: translate('Update failed') });
  for (const { repo, res } of results) {
    if (res.outcome.kind !== 'skipped') await reportRestore(repo, res.saver, 'update', res.restore, res.savedChangesKept ?? false);
  }
  // The tracked branch was force-pushed: offer IntelliJ's "Update Force-Pushed Branch".
  for (const { repo, res } of results) {
    if (!res.forcePushed) continue;
    void vscode.window
      .showWarningMessage(
        translate(
          '{0} was force-pushed: the tracked branch was rewritten on the remote. Update the current branch by resetting it to {0} and cherry-picking the local commits?',
          res.forcePushed.upstream,
        ),
        translate('Update Force-Pushed Branch'),
      )
      .then(a => a && vscode.commands.executeCommand('ideagittool.updateForcePushedBranch', { root: repo.root }));
  }
  if (failed.length) return;
  if (skipped.length === results.length) {
    const reason = (skipped[0].res.outcome as { reason: string }).reason;
    const name = currentName(skipped[0].repo);
    void vscode.window.showWarningMessage(
      reason === 'detached HEAD'
        ? translate("Can't update: no current branch. You are in 'detached HEAD' state, which means that you're not on any branch. Checkout a branch to make update possible.")
        : translate("Can't update: no tracked branch. No tracked branch configured for branch {0} or the branch doesn't exist. To make your branch track a remote branch call, for example, git branch --set-upstream-to=origin/{0} {0}", name),
    );
    return;
  }
  const commits = results.reduce((s, r) => s + r.res.commits, 0);
  const files = results.reduce((s, r) => s + r.res.files, 0);
  const title = skipped.length ? translate('Project Partially Updated') : translate('Project updated');
  const skippedList = skipped.map(s => translate('{0} was skipped ({1})', s.repo.name, skipReason((s.res.outcome as { reason: string }).reason))).join(', ');
  const skippedText = skipped.length
    ? ' ' + (skipped.length === 1 ? translate('Skipped {0} repository: {1}', skipped.length, skippedList) : translate('Skipped {0} repositories: {1}', skipped.length, skippedList))
    : '';
  if (commits === 0) {
    void vscode.window.showInformationMessage(translate('All files are up-to-date') + skippedText);
    return;
  }
  const first = results.find(r => r.res.commits > 0)!;
  const a = await vscode.window.showInformationMessage(`${translate('{0}: {1}', title, updateSummary(files, commits))}${skippedText}`, translate('View Commits'));
  if (a) void vscode.commands.executeCommand('ideagittool.compareRefs', { root: first.repo.root, ref: first.res.after, with: first.res.before });
}

/** "Reset to the Remote Branch" (left button of the Update dialog). */
export async function resetToRemoteCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  const branch = repo.info.branch;
  if (!branch) {
    void vscode.window.showErrorMessage(translate("Can't update: no current branch. You are in 'detached HEAD' state, which means that you're not on any branch. Checkout a branch to make update possible."));
    return;
  }
  const upstream = repo.currentBranchRef?.upstream;
  if (!upstream) {
    void vscode.window.showErrorMessage(
      translate("Can't update: no tracked branch. No tracked branch configured for branch {0} or the branch doesn't exist. To make your branch track a remote branch call, for example, git branch --set-upstream-to=origin/{0} {0}", branch),
    );
    return;
  }
  const okLabel = translate('OK');
  const ok = await vscode.window.showWarningMessage(
    translate('Reset to the Remote Branch'),
    { modal: true, detail: translate('Do you want to reset local branch {0} to {1}? Local commits will be dropped', branch, upstream) },
    okLabel,
  );
  if (ok !== okLabel) return;
  await putLocalHistoryLabel(repo, translate('Before Update'));
  let res: Awaited<ReturnType<typeof resetToRemoteBranch>> | undefined;
  const outcome = await withSmartOperation(
    repo,
    'checkout',
    async force => {
      res = await withProgress(translate('Updating…'), (progress, token) => repo.batch(() => resetToRemoteBranch(repo, { progress, token, force })));
      return res.outcome.kind === 'skipped' ? { kind: 'success', output: '' } : res.outcome;
    },
    { destination: upstream },
  );
  if (!outcome || !res) return;
  if (outcome.kind !== 'success') {
    await reportOutcome(repo, outcome, { operation: 'update', failedTitle: translate('Update failed') });
    return;
  }
  void vscode.window.showInformationMessage(res.before === res.after ? translate('All files are up-to-date') : translate('Project updated: {0} was reset to {1}', branch, upstream));
}

/** `ideagittool.updateForcePushedBranch {root?}`: IntelliJ's "Update Force-Pushed Branch". */
export async function updateForcePushedBranchCommand(ctx: Ctx, arg?: RootArg) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  const method: UpdateMethod = settings().get<string>('updateMethod', 'merge') === 'rebase' ? 'rebase' : 'merge';
  let anyError = false;
  await withProgress(translate('Performing force-pushed branch update…'), async (progress, token) => {
    for (const repo of repos) {
      if (repo.detectOperation() !== 'none' || repo.status.conflicts.length) {
        void vscode.window.showErrorMessage(translate("Can't update: Unmerged files detected. These conflicts must be resolved before update."));
        anyError = true;
        continue;
      }
      const saver = makeSaver();
      await putLocalHistoryLabel(repo, translate('Before Update'));
      const m = await methodFor(repo, method);
      const r = await repo.batch(() => updateForcePushedBranch(repo, { progress, token, saver, method: m }));
      if (r.result === 'regular' && r.update) {
        if (r.update.outcome.kind !== 'success' && r.update.outcome.kind !== 'skipped') {
          anyError = true;
          await reportOutcome(repo, r.update.outcome, { operation: 'update', failedTitle: translate('Update failed') });
        }
        await reportRestore(repo, saver, 'update', r.update.restore, r.update.savedChangesKept ?? false);
      } else if (r.result === 'incomplete') {
        anyError = true;
        void vscode.window.showWarningMessage(translate('Not all local commits were cherry-picked from {0} branch', r.backup ?? ''));
        if (r.cherryPick && r.cherryPick.kind !== 'success') await reportOutcome(repo, r.cherryPick, { operation: 'cherry-pick' });
      } else if (r.result === 'error') {
        anyError = true;
        await reportOutcome(repo, { kind: 'error', output: '', error: r.error! }, { operation: 'update', failedTitle: translate('Update failed') });
      } else if (r.restore) {
        await reportRestore(repo, saver, 'update', r.restore, r.restore.kind === 'error');
      }
    }
  });
  if (!anyError) void vscode.window.showInformationMessage(translate('Update of possible force-pushed branch was successful'));
}
