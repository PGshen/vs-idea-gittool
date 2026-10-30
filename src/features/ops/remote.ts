import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { Ctx } from '../../context';
import { git } from '../../git/exec';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { openChangeDiff } from '../../host/gitContent';
import { withProgress } from '../../host/ui';
import { CancelledError, showError } from '../../host/webviewHost';
import { Change } from '../../shared/types';
import { commitChanges } from './changes';
import { currentName, repoFor, reportOutcome, reportRestore, RootArg, settings } from './common';
import { updateWithSavedChanges } from './update';
import { countCommits, fetch, push, PushSpec, pushSuccessMessage, runConflictAware, updateRepository, UpdateMethod, updateSummary } from './engine';

interface PushCommit {
  hash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: number;
}

async function remoteBranchExists(repo: Repository, remote: string, target: string) {
  const r = await repo.exec(['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${target}`], { allowFailure: true, quiet: true });
  return r.exitCode === 0;
}

/** Commits that `source` would push to remote/target. */
export async function outgoingCommits(repo: Repository, source: string, remote: string, target: string): Promise<{ commits: PushCommit[]; isNew: boolean }> {
  const isNew = !(await remoteBranchExists(repo, remote, target));
  const args = ['log', '--format=%H%x00%s%x00%B%x00%an%x00%ae%x00%at%x01', '-n', '1000', source];
  if (!isNew) args.push(`^refs/remotes/${remote}/${target}`);
  else if (repo.refs.some(r => r.type === 'remote' && r.remote === remote)) args.push('--not', `--remotes=${remote}`);
  const r = await repo.exec(args, { allowFailure: true, quiet: true });
  const commits = r.stdout
    .split('\x01')
    .map(s => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map(rec => {
      const [hash, subject, body, author, authorEmail, at] = rec.split('\0');
      return { hash, subject, body: body.trim(), author, authorEmail, date: +at };
    });
  return { commits, isNew };
}

function defaultRemote(repo: Repository): string | undefined {
  return repo.remotes.find(r => r.name === 'origin')?.name ?? repo.remotes[0]?.name;
}

/** `ideagittool.push {root?, upTo?, branch?}`: the Push Commits dialog. */
export async function pushCommand(ctx: Ctx, arg?: RootArg & { upTo?: string; branch?: string }) {
  await ctx.repos.ready();
  let repos: Repository[];
  if (arg?.root) repos = [await repoFor(ctx, arg)];
  else repos = ctx.repos.repositories.filter(r => r.info.branch || r.info.headHash);
  if (repos.length === 0) throw new Error(translate('No Git repository found in the workspace.'));
  const items: {
    root: string;
    name: string;
    source: string;
    sourceRef: string;
    remote: string;
    target: string;
    remotes: string[];
    remoteBranches: Record<string, string[]>;
    commits: PushCommit[];
    isNew: boolean;
    hasUpstream: boolean;
    checked: boolean;
    problem?: string;
  }[] = [];
  for (const repo of repos) {
    const branch = arg?.branch ?? repo.info.branch;
    const source = arg?.upTo ?? branch ?? 'HEAD';
    const local = branch ? repo.refs.find(r => r.type === 'local' && r.name === branch) : undefined;
    const upstream = local?.upstream;
    const upRemote = upstream ? repo.remotes.map(r => r.name).find(n => upstream.startsWith(n + '/')) : undefined;
    const remote = upRemote ?? defaultRemote(repo);
    const target = upstream && upRemote ? upstream.slice(upRemote.length + 1) : (branch ?? 'master');
    const remoteBranches: Record<string, string[]> = {};
    for (const r of repo.refs.filter(x => x.type === 'remote')) (remoteBranches[r.remote!] ??= []).push(r.name.slice(r.remote!.length + 1));
    let problem: string | undefined;
    if (!repo.info.headHash) problem = translate('Empty repository');
    else if (!remote) problem = translate('Define remote');
    else if (!branch && !arg?.upTo) problem = translate('Cannot push (detached HEAD)');
    const out = remote && !problem ? await outgoingCommits(repo, source, remote, target) : { commits: [], isNew: false };
    items.push({
      root: repo.root,
      name: repo.name,
      source: arg?.upTo ? translate('{0} (up to {1})', branch ?? 'HEAD', arg.upTo.slice(0, 8)) : (branch ?? 'HEAD'),
      sourceRef: source,
      remote: remote ?? '',
      target,
      remotes: repo.remotes.map(r => r.name),
      remoteBranches,
      commits: out.commits,
      isNew: out.isNew,
      hasUpstream: !!upstream,
      checked: repos.length === 1 || repo.root === arg?.root || out.commits.length > 0 || repo === ctx.repos.getForFile(vscode.window.activeTextEditor?.document.uri.fsPath ?? ''),
      problem,
    });
  }
  if (repos.length > 1 && !items.some(i => i.checked)) items.forEach(i => (i.checked = true));

  const title = repos.length === 1 ? translate('Push Commits to {0}', repos[0].name) : translate('Push Commits');
  const result = await showDialog<{
    repos: { root: string; remote: string; target: string; setUpstream: boolean; isNew: boolean; count: number }[];
    force?: 'lease' | 'force';
    tags: 'none' | 'all' | 'current';
    runHooks: boolean;
  }>(
    'ops.push',
    { title, repos: items, tagsMode: settings().get('push.tags', 'none'), runHooks: settings().get('push.runHooks', true), forceAllowed: true },
    {
      title,
      handlers: {
        commits: async (p: { root: string; remote: string; target: string }) => {
          const it = items.find(i => i.root === p.root)!;
          const repo = ctx.repos.get(p.root)!;
          return outgoingCommits(repo, it.sourceRef, p.remote, p.target);
        },
        commitChanges: async (p: { root: string; hashes: string[] }) => commitChanges(ctx.repos.get(p.root)!, p.hashes),
        showDiff: async (p: { change: Change & { hash: string } }) => openChangeDiff(p.change, `${p.change.hash}^`, p.change.hash),
      },
    },
  );
  if (!result) return;
  if (result.force) {
    const targets = result.repos.map(x => `${x.remote}/${x.target}`).join(', ');
    const forcePush = translate('Force Push');
    const a = await vscode.window.showWarningMessage(
      forcePush,
      { modal: true, detail: translate("You're going to force push to {0}. It may overwrite commits at the remote. Are you sure you want to proceed?", targets) },
      forcePush,
    );
    if (a !== forcePush) return;
  }
  await settings().update('push.tags', result.tags, vscode.ConfigurationTarget.Global);
  await settings().update('push.runHooks', result.runHooks, vscode.ConfigurationTarget.Global);
  for (const r of result.repos) {
    const repo = ctx.repos.get(r.root)!;
    const it = items.find(i => i.root === r.root)!;
    await doPush(
      ctx,
      repo,
      {
        remote: r.remote,
        source: it.sourceRef,
        target: r.target,
        force: result.force,
        tags: result.tags === 'none' ? undefined : result.tags,
        noVerify: !result.runHooks,
        setUpstream: r.setUpstream && !arg?.upTo,
      },
      r.isNew,
    );
  }
}

/** Pushes with progress, handles a rejected push with the "Push Rejected" dialog, then notifies. */
export async function doPush(ctx: Ctx, repo: Repository, spec: PushSpec, isNew: boolean, retried = false): Promise<boolean> {
  const count = isNew ? 0 : await countCommits(repo, `refs/remotes/${spec.remote}/${spec.target}..${spec.source}`);
  const res = await withProgress(
    translate('Pushing…'),
    (progress, token) => push(repo, spec, { progress, token }),
    { cancellable: true },
  );
  await repo.refresh();
  if (res.ok) {
    const forced = !!spec.force && res.refs.some(r => r.flag === '+');
    const upToDate = res.refs.every(r => r.flag === '=');
    const msg = upToDate ? translate('Everything is up to date') : pushSuccessMessage(spec, count, res.refs.some(r => r.flag === '*') || isNew, forced);
    void vscode.window.showInformationMessage(translate('Push successful: {0}', msg));
    return true;
  }
  if (res.needsUpdate && !spec.force && !retried && repo.info.branch) {
    const remembered = settings().get<string>('push.autoUpdateOnRejected', '');
    let method: UpdateMethod | undefined = remembered === 'merge' || remembered === 'rebase' ? remembered : undefined;
    if (!method) {
      const merges = await repo.exec(['rev-list', '--count', '--merges', `refs/remotes/${spec.remote}/${spec.target}..${spec.source}`], { allowFailure: true, quiet: true });
      const hasMerges = +merges.stdout.trim() > 0;
      const choice = await showDialog<{ button: string; remember: boolean }>('ops.pushRejected', { branch: repo.info.branch, hasMerges }, { title: translate('Push Rejected') });
      if (!choice || choice.button === 'cancel') {
        void vscode.window.showWarningMessage(translate('Push rejected: Push to {0} was rejected', `${spec.remote}/${spec.target}`));
        return false;
      }
      method = choice.button as UpdateMethod;
      if (choice.remember) await settings().update('push.autoUpdateOnRejected', method, vscode.ConfigurationTarget.Global);
    }
    const up = await withProgress(translate('Updating…'), (progress, token) => updateWithSavedChanges(repo, method!, { progress, token }));
    if (up.outcome.kind !== 'success') {
      await reportOutcome(repo, up.outcome as never, { operation: 'update', failedTitle: translate('Push was rejected, and update failed with an error') });
      await reportRestore(repo, up.saver, 'update', up.restore, up.savedChangesKept ?? false);
      return false;
    }
    await reportRestore(repo, up.saver, 'update', up.restore, up.savedChangesKept ?? false);
    return doPush(ctx, repo, spec, isNew, true);
  }
  if (res.rejected) {
    const a = await vscode.window.showErrorMessage(
      spec.force === 'lease'
        ? translate('Push rejected: Force-with-lease push {0} to {1} was rejected', spec.source, `${spec.remote}/${spec.target}`)
        : `${translate('Push rejected: Push to {0} was rejected', `${spec.remote}/${spec.target}`)}\n${res.output}`,
      translate('Show Git Console'),
    );
    if (a) void vscode.commands.executeCommand('ideagittool.showConsole');
    return false;
  }
  showError(res.error ?? res.output, translate('Push failed'));
  return false;
}

/** `ideagittool.fetch {root?}`: fetches all remotes of all (or one) repositories. */
export async function fetchCommand(ctx: Ctx, arg?: RootArg) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  const failures: string[] = [];
  await withProgress(
    translate('Fetching…'),
    async (progress, token) => {
      for (const repo of repos) {
        if (repo.remotes.length === 0) continue;
        const r = await fetch(repo, 'all', { progress: t => progress(repos.length > 1 ? `${repo.name}: ${t}` : t), token, prune: settings().get('fetch.prune', false) });
        if (!r.ok) failures.push(`${repo.name}: ${r.error?.message}`);
        await repo.refresh();
      }
    },
    { cancellable: true },
  );
  if (failures.length) showError(failures.join('\n'), translate('Fetch failed'));
  else void vscode.window.showInformationMessage(translate('Fetch successful'));
}

/** `ideagittool.pull {root?}`: the Pull dialog. */
export async function pullCommand(ctx: Ctx, arg?: RootArg & { remote?: string; branch?: string; options?: string[] }) {
  const repo = await repoFor(ctx, arg);
  const repos = arg?.root ? [repo] : ctx.repos.repositories;
  const remotes: Record<string, string[]> = {};
  const remoteBranches: Record<string, Record<string, string[]>> = {};
  const defaultRemoteMap: Record<string, string> = {};
  const defaultBranch: Record<string, string> = {};
  for (const r of repos) {
    remotes[r.root] = r.remotes.map(x => x.name);
    remoteBranches[r.root] = {};
    for (const ref of r.refs.filter(x => x.type === 'remote')) (remoteBranches[r.root][ref.remote!] ??= []).push(ref.name.slice(ref.remote!.length + 1));
    const up = r.info.upstream;
    const upRemote = up ? r.remotes.map(x => x.name).find(n => up.startsWith(n + '/')) : undefined;
    defaultRemoteMap[r.root] = arg?.remote ?? upRemote ?? defaultRemote(r) ?? '';
    defaultBranch[r.root] = arg?.branch ?? (up && upRemote ? up.slice(upRemote.length + 1) : (r.info.branch ?? ''));
  }
  if (!repo.remotes.length) throw new Error(translate('No remotes defined. Use Git | Manage Remotes… to add a remote.'));
  const res = await showDialog<{ root: string; remote: string; branch: string; options: string[] }>(
    'ops.pull',
    {
      repos: repos.map(r => ({ root: r.root, name: r.name, branch: currentName(r) })),
      root: repo.root,
      remotes,
      remoteBranches,
      defaultRemote: defaultRemoteMap,
      defaultBranch,
      options: arg?.options,
    },
    { title: translate('Pull to {0}', currentName(repo)) },
  );
  if (!res) return;
  const target = ctx.repos.get(res.root)!;
  await pull(target, res.remote, res.branch, res.options);
}

export async function pull(repo: Repository, remote: string, branch: string, options: string[]) {
  const args = ['pull', '--progress', '--no-edit'];
  if (!options.includes('rebase')) args.push('--no-rebase');
  for (const o of options) args.push(o === 'rebase' ? '--rebase' : `--${o}`);
  args.push(remote, branch);
  const before = repo.info.headHash;
  const outcome = await withProgress(translate('Pulling {0}…', `${remote}/${branch}`), (progress, token) => repo.batch(() => runConflictAware(repo, args, { progress, token })), { cancellable: true });
  if (outcome.kind === 'success' && before) {
    const after = (await repo.execText(['rev-parse', 'HEAD'], { quiet: true })).trim();
    const commits = await countCommits(repo, `${before}..${after}`);
    if (commits === 0) {
      void vscode.window.showInformationMessage(translate('All files are up-to-date'));
      return;
    }
    const files = (await repo.execText(['diff', '--name-only', before, after], { quiet: true })).split('\n').filter(Boolean).length;
    const a = await vscode.window.showInformationMessage(translate('Project updated: {0}', updateSummary(files, commits)), translate('View Commits'));
    if (a) void vscode.commands.executeCommand('ideagittool.compareRefs', { root: repo.root, ref: after, with: before });
    return;
  }
  await reportOutcome(repo, outcome, { operation: 'pull', failedTitle: translate('Pull failed') });
}

// ------------------------------------------------------------------ remotes / clone / init

export async function remotesCommand(ctx: Ctx, arg?: RootArg) {
  await ctx.repos.ready();
  const repos = arg?.root ? [await repoFor(ctx, arg)] : ctx.repos.repositories;
  if (!repos.length) throw new Error(translate('No Git repository found in the workspace.'));
  const rows = () => repos.flatMap(r => r.remotes.map(x => ({ root: r.root, repo: r.name, name: x.name, url: x.fetchUrl })));
  await showDialog('ops.remotes', { remotes: rows(), repos: repos.map(r => ({ root: r.root, name: r.name })) }, {
    title: translate('Git Remotes'),
    handlers: {
      addRemote: async (p: { root: string; name: string; url: string }) => {
        const repo = ctx.repos.get(p.root)!;
        await repo.exec(['remote', 'add', p.name, p.url]);
        await repo.refresh();
        // IntelliJ fetches the new remote right away.
        void withProgress(translate('Fetching {0}…', p.name), (progress, token) => fetch(repo, p.name, { progress, token }).then(() => repo.refresh()), { location: 'window' });
        return rows();
      },
      editRemote: async (p: { root: string; oldName: string; name: string; url: string }) => {
        const repo = ctx.repos.get(p.root)!;
        if (p.oldName !== p.name) await repo.exec(['remote', 'rename', p.oldName, p.name]);
        await repo.exec(['remote', 'set-url', p.name, p.url]);
        await repo.refresh();
        return rows();
      },
      removeRemote: async (p: { root: string; name: string }) => {
        const remove = translate('Remove');
        const a = await vscode.window.showWarningMessage(translate('Remove remote {0}?', p.name), { modal: true }, remove);
        if (a !== remove) return rows();
        const repo = ctx.repos.get(p.root)!;
        await repo.exec(['remote', 'remove', p.name]);
        await repo.refresh();
        return rows();
      },
    },
  });
}

export async function cloneCommand(ctx: Ctx) {
  const parent = vscode.workspace.workspaceFolders?.[0] ? path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath) : os.homedir();
  let cloned: string | undefined;
  await showDialog('ops.clone', { parent }, {
    title: translate('Clone Repository'),
    handlers: { browse: (current: string) => browseFolder(current) },
    validate: async (v: { url: string; dir: string; depth?: number }) => {
      if (fs.existsSync(v.dir) && fs.readdirSync(v.dir).length > 0) return translate('Directory {0} already exists and is not empty', v.dir);
      const args = ['clone', '--progress', v.url, v.dir];
      if (v.depth) args.push('--depth', String(v.depth));
      try {
        await withProgress(
          translate('Cloning {0}…', v.url),
          (progress, token) =>
            git(args, {
              cwd: fs.existsSync(path.dirname(v.dir)) ? path.dirname(v.dir) : os.homedir(),
              token,
              onStderrLine: l => {
                const m = /([A-Za-z ]+):\s+(\d+)%/.exec(l);
                if (m) progress(`${m[1]}: ${m[2]}%`);
              },
            }),
          { cancellable: true },
        );
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      cloned = v.dir;
      return true;
    },
  });
  if (!cloned) return;
  const open = translate('Open');
  const openInNewWindow = translate('Open in New Window');
  const addToWorkspace = translate('Add to Workspace');
  const a = await vscode.window.showInformationMessage(translate('Cloned to {0}. Would you like to open the cloned repository?', cloned), open, openInNewWindow, addToWorkspace);
  const uri = vscode.Uri.file(cloned);
  if (a === open) await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
  else if (a === openInNewWindow) await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  else if (a === addToWorkspace) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
}

export async function browseFolder(current?: string): Promise<string | null> {
  const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: current && fs.existsSync(current) ? vscode.Uri.file(current) : undefined });
  return r?.[0]?.fsPath ?? null;
}

export async function initCommand(ctx: Ctx) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  let dir: string | undefined;
  if (folders.length === 1) dir = folders[0].uri.fsPath;
  else if (folders.length > 1) dir = (await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, dir: f.uri.fsPath })), { placeHolder: translate('Select directory for git init') }))?.dir;
  if (!dir) dir = (await browseFolder()) ?? undefined;
  if (!dir) throw new CancelledError();
  await git(['init'], { cwd: dir });
  await ctx.repos.open(dir);
  void vscode.window.showInformationMessage(translate('Created Git repository in {0}', dir));
}

export async function unshallowCommand(ctx: Ctx, arg?: RootArg) {
  const repo = await repoFor(ctx, arg);
  await withProgress(translate('Unshallowing repository…'), (progress, token) => repo.exec(['fetch', '--unshallow', '--progress'], { token, onStderrLine: l => progress(l) }), { cancellable: true });
  await repo.refresh();
  void vscode.window.showInformationMessage(translate('Repository unshallowed'));
}
