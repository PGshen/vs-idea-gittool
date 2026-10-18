import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { openChangeDiff, REV_EMPTY, toGitUri } from '../../host/gitContent';
import { notifySuccess, withProgress } from '../../host/ui';
import { changeKey } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { StatusDecorations } from './decorations';
import { addFiles, addToGitignore, stashFiles } from './gitOps';
import { createPatchFromCommits } from './patchCommits';
import { initPatchDialog } from './patchDialog';
import { CommitView, copyPaths, CopyPathKind } from './view';

export function register(ctx: Ctx) {
  const view = new CommitView(ctx);
  ctx.commitView = view;
  initPatchDialog(ctx.extension.globalState);
  ctx.extension.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ideagittool.commit', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerFileDecorationProvider(new StatusDecorations(ctx.repos)),
  );

  /** Changes under the given files or folders (Explorer / editor context menus). */
  const changesFor = (uri?: vscode.Uri, uris?: vscode.Uri[]): Change[] => {
    const targets = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    const out: Change[] = [];
    for (const u of targets) {
      if (u.scheme !== 'file') continue;
      const repo = ctx.repos.getForFile(u.fsPath);
      if (!repo) continue;
      const rel = repo.relPath(u.fsPath);
      const all = [...repo.status.changes, ...repo.status.unversioned];
      for (const c of all) {
        if (rel === '' || c.path === rel || c.path.startsWith(rel + '/') || c.oldPath === rel) out.push(c);
      }
    }
    return out;
  };
  const isUriArg = (a: unknown): a is vscode.Uri => a instanceof vscode.Uri;
  const keysUnder = (uri?: unknown, uris?: vscode.Uri[]) => changesFor(isUriArg(uri) ? uri : undefined, uris).map(changeKey);
  /** Tracked files under the selection, including unchanged ones (Remove from VCS works on any tracked file). */
  const trackedKeys = (uri?: unknown, uris?: vscode.Uri[]) => {
    const targets = uris?.length ? uris : isUriArg(uri) ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    const keys: string[] = [];
    for (const u of targets) {
      const repo = ctx.repos.getForFile(u.fsPath);
      if (!repo) continue;
      const rel = repo.relPath(u.fsPath);
      if ([...repo.status.unversioned, ...repo.status.ignored].some(c => c.path === rel)) continue;
      keys.push(changeKey({ root: repo.root, path: rel }));
    }
    return keys;
  };

  // Used by Undo Commit to put the message of the undone commit back into the commit panel.
  ctx.command('ideagittool.setCommitMessage', async (arg: { root?: string; message: string }) => {
    await ctx.extension.workspaceState.update('ideagittool.commit.draft', arg.message);
    await vscode.commands.executeCommand('ideagittool.commit.focus');
    view.post('setMessage', arg.message);
  });
  ctx.command('ideagittool.commit', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    if (isUriArg(uri)) {
      const changes = changesFor(uri, uris);
      if (changes.length) return view.commitFiles(changes.map(changeKey));
    }
    await view.reveal('commit');
    view.post('focusMessage');
  });
  ctx.command('ideagittool.commitAndPush', async () => {
    await view.reveal('commit');
    view.post('commitAndPush');
  });
  ctx.command('ideagittool.resolveConflicts', (a?: { root?: string }) => view.conflicts.show(a?.root));
  ctx.command('ideagittool.refreshChanges', async () => {
    await ctx.repos.scan();
    await Promise.all(ctx.repos.repositories.map(r => r.refresh()));
  });
  ctx.command('ideagittool.rollback', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    if (isUriArg(uri) || !uri) {
      const changes = changesFor(uri as vscode.Uri | undefined, uris).filter(c => c.status !== '?');
      if (isUriArg(uri) && !changes.length) {
        void vscode.window.showInformationMessage('No changes to roll back');
        return;
      }
      return view.rollbackDialog(changes.map(changeKey), !isUriArg(uri) && !vscode.window.activeTextEditor);
    }
    return view.rollbackDialog([], true);
  });
  ctx.command('ideagittool.addToVcs', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const changes = changesFor(uri, uris).filter(c => c.status === '?');
    const byRepo = new Map<Repository, string[]>();
    for (const c of changes) {
      const r = ctx.repos.get(c.root)!;
      byRepo.set(r, [...(byRepo.get(r) ?? []), c.path]);
    }
    for (const [r, paths] of byRepo) await r.batch(() => addFiles(r, paths, true));
  });
  ctx.command('ideagittool.addToGitignore', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    for (const u of targets) {
      const repo = ctx.repos.getForFile(u.fsPath);
      if (!repo) continue;
      addToGitignore(repo, [repo.relPath(u.fsPath)]);
      await repo.refresh();
    }
  });
  ctx.command('ideagittool.showLocalDiff', async (uri?: vscode.Uri) => {
    const u = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!u || u.scheme !== 'file') return;
    const repo = ctx.repos.getForFile(u.fsPath);
    if (!repo) return;
    const rel = repo.relPath(u.fsPath);
    const c = [...repo.status.changes, ...repo.status.unversioned].find(x => x.path === rel) ?? { root: repo.root, path: rel, status: 'M' as const };
    await openChangeDiff(c, repo.info.empty ? REV_EMPTY : 'HEAD', 'WORKTREE');
  });
  ctx.command('ideagittool.shelve', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    const keys = isUriArg(uri) ? changesFor(uri, uris).map(changeKey) : [];
    if (isUriArg(uri)) view.buildState();
    return view.shelveDialog(keys);
  });
  // Swallows shortcuts that the Commit view handles itself, so that VS Code does not run its own
  // command for them too (Ctrl+Shift+H would open Replace in Files).
  ctx.command('ideagittool.noop', () => undefined);
  // Toolbar: shelve the included changes. API for Update Project: {root, name} shelves all local changes
  // of the repository and returns the shelf id (undefined when there is nothing to shelve).
  ctx.command('ideagittool.shelveSilently', (arg?: unknown) => {
    if (arg && typeof arg === 'object' && 'root' in arg && typeof (arg as { root: unknown }).root === 'string') {
      const a = arg as { root: string; name?: string };
      return view.shelveAll(a.root, a.name ?? 'Uncommitted changes before Update');
    }
    return view.shelveSilently([]);
  });
  ctx.command('ideagittool.unshelveSilently', (arg?: { id?: string }) => {
    if (arg?.id) return view.unshelveAll(arg.id);
    return view.reveal('shelf');
  });
  ctx.command('ideagittool.removeFromVcs', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    view.buildState();
    return view.removeFromVcs(trackedKeys(uri, uris));
  });
  ctx.command('ideagittool.revertResolved', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    view.buildState();
    return view.revertResolved(isUriArg(uri) ? keysUnder(uri, uris) : undefined);
  });
  // Rollback File…: the Rollback Changes dialog for the selected files only.
  ctx.command('ideagittool.rollbackFile', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    const keys = changesFor(isUriArg(uri) ? uri : undefined, uris)
      .filter(c => c.status !== '?')
      .map(changeKey);
    if (!keys.length) {
      void vscode.window.showInformationMessage('No changes to roll back');
      return;
    }
    view.buildState();
    return view.rollbackDialog(keys);
  });
  ctx.command('ideagittool.copyPath', async (arg?: { kind?: CopyPathKind } | vscode.Uri, uris?: vscode.Uri[], kindArg?: CopyPathKind) => {
    // From menus: (uri, uris) with the kind bound by the command id; from code: {kind}.
    const kind = kindArg ?? (arg && !(arg instanceof vscode.Uri) ? arg.kind : undefined) ?? 'absolute';
    const editor = vscode.window.activeTextEditor;
    const targets = uris?.length ? uris : arg instanceof vscode.Uri ? [arg] : editor ? [editor.document.uri] : [];
    const files = targets.filter(u => u.scheme === 'file').map(u => u.fsPath);
    if (!files.length) return;
    const line = editor && files.length === 1 && editor.document.uri.fsPath === files[0] ? editor.selection.active.line + 1 : undefined;
    await copyPaths(files, kind, ctx, line);
  });
  for (const kind of ['absolute', 'name', 'lineNumber', 'contentRoot', 'repo', 'reference'] as CopyPathKind[]) {
    ctx.command(`ideagittool.copyPath.${kind}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => vscode.commands.executeCommand('ideagittool.copyPath', uri, uris, kind));
  }
  ctx.command('ideagittool.createPatchFromChanges', async (arg?: { keys?: string[]; changes?: Change[]; root?: string; hashes?: string[] } | vscode.Uri, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    view.buildState();
    if (arg instanceof vscode.Uri || !arg) return view.createPatchFile(arg ? changesFor(arg, uris) : []);
    if (arg.hashes?.length && arg.root) return createPatchFromCommits(ctx, arg.root, arg.hashes, arg.changes);
    return view.createPatchFile(arg.changes ?? view.changes(arg.keys ?? []));
  });
  ctx.command('ideagittool.unshelve', () => view.reveal('shelf'));
  ctx.command('ideagittool.showShelf', () => view.reveal('shelf'));
  ctx.command('ideagittool.showStashes', () => view.reveal('stash'));
  ctx.command('ideagittool.newChangelist', () => view.newChangelist());
  ctx.command('ideagittool.importPatches', () => view.importPatches());

  ctx.command('ideagittool.stash', async (a?: { root?: string }) => {
    await ctx.repos.ready();
    const repos = ctx.repos.repositories;
    if (!repos.length) return;
    const root = a?.root ?? (await ctx.repos.pick())?.root;
    if (!root) return;
    const res = await showDialog<{ root: string; message: string; keepIndex: boolean; includeUntracked: boolean }>(
      'commit.stash',
      { repos: repos.map(r => ({ root: r.root, name: r.name, branch: r.info.branch ?? r.info.headHash?.slice(0, 8) })), root },
      { title: 'Stash' },
    );
    if (!res) return;
    const repo = ctx.repos.get(res.root);
    if (!repo) return;
    const args = ['stash', 'push'];
    if (res.message.trim()) args.push('-m', res.message.trim());
    if (res.keepIndex) args.push('--keep-index');
    if (res.includeUntracked) args.push('--include-untracked');
    await withProgress(`Stashing changes from '${repo.name}'…`, () => repo.batch(() => repo.exec(args)), { location: 'window' });
  });

  ctx.command('ideagittool.unstash', async (a?: { root?: string; ref?: string }) => {
    await ctx.repos.ready();
    const repos = ctx.repos.repositories;
    if (!repos.length) return;
    const root = a?.root ?? (await ctx.repos.pick())?.root;
    if (!root) return;
    const list = (r: string) => ctx.repos.get(r)?.stashes ?? [];
    const res = await showDialog<{ root: string; ref: string; pop: boolean; reinstateIndex: boolean; branch: string }>(
      'commit.unstash',
      { repos: repos.map(r => ({ root: r.root, name: r.name, branch: r.info.branch ?? r.info.headHash?.slice(0, 8) })), root, ref: a?.ref, stashes: list(root) },
      {
        title: 'Unstash Changes',
        onOpen: conn => {
          const sub = ctx.repos.onDidChangeRepository(() => conn.post('stashes', null));
          ctx.extension.subscriptions.push(sub);
        },
        handlers: {
          list: (p: { root: string }) => list(p.root),
          view: async (p: { root: string; hash: string; ref: string }) => {
            const repo = ctx.repos.get(p.root);
            if (!repo) return;
            const files = await stashFiles(repo, p.hash);
            await vscode.commands.executeCommand(
              'vscode.changes',
              `Paths Affected by ${p.ref}`,
              files.map(f => [vscode.Uri.file(path.join(f.root, f.path)), f.left && f.status !== 'A' ? toGitUri(f.root, f.oldPath ?? f.path, f.left) : undefined, f.status === 'D' ? undefined : toGitUri(f.root, f.path, f.right)]),
            );
          },
          drop: async (p: { root: string; ref: string; message: string }) => {
            await view.stashDrop(p.root, p.ref, p.message);
            return list(p.root);
          },
          clear: async (p: { root: string }) => {
            await view.stashClear(p.root);
            return list(p.root);
          },
        },
      },
    );
    if (!res) return;
    const repo = ctx.repos.get(res.root);
    if (!repo) return;
    if (res.branch.trim()) {
      await withProgress('Unstashing…', () => repo.batch(() => repo.exec(['stash', 'branch', res.branch.trim(), res.ref])), { location: 'window' });
      void notifySuccess('Stash successfully applied', `Checked out as new branch ${res.branch.trim()}`);
      return;
    }
    await view.stashApply(res.root, res.ref, res.pop, res.reinstateIndex);
  });

  // Keep the explorer context keys for menus in sync.
  const updateContext = () => {
    const hasConflicts = ctx.repos.repositories.some(r => r.status.conflicts.length > 0);
    void vscode.commands.executeCommand('setContext', 'ideagittool.hasConflicts', hasConflicts);
    void vscode.commands.executeCommand('setContext', 'ideagittool.inOperation', ctx.repos.repositories.some(r => r.info.operation !== 'none'));
  };
  ctx.repos.onDidChangeRepository(updateContext);
}
