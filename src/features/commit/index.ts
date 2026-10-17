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
import { CommitView } from './view';

export function register(ctx: Ctx) {
  const view = new CommitView(ctx);
  ctx.extension.subscriptions.push(
    vscode.window.registerWebviewViewProvider('rebased.commit', view, { webviewOptions: { retainContextWhenHidden: true } }),
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

  // Used by Undo Commit to put the message of the undone commit back into the commit panel.
  ctx.command('rebased.setCommitMessage', async (arg: { root?: string; message: string }) => {
    await ctx.extension.workspaceState.update('rebased.commit.draft', arg.message);
    await vscode.commands.executeCommand('rebased.commit.focus');
    view.post('setMessage', arg.message);
  });
  ctx.command('rebased.commit', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    if (isUriArg(uri)) {
      const changes = changesFor(uri, uris);
      if (changes.length) return view.commitFiles(changes.map(changeKey));
    }
    await view.reveal('commit');
    view.post('focusMessage');
  });
  ctx.command('rebased.commitAndPush', async () => {
    await view.reveal('commit');
    view.post('commitAndPush');
  });
  ctx.command('rebased.resolveConflicts', (a?: { root?: string }) => view.conflicts.show(a?.root));
  ctx.command('rebased.refreshChanges', async () => {
    await ctx.repos.scan();
    await Promise.all(ctx.repos.repositories.map(r => r.refresh()));
  });
  ctx.command('rebased.rollback', async (uri?: unknown, uris?: vscode.Uri[]) => {
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
  ctx.command('rebased.addToVcs', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const changes = changesFor(uri, uris).filter(c => c.status === '?');
    const byRepo = new Map<Repository, string[]>();
    for (const c of changes) {
      const r = ctx.repos.get(c.root)!;
      byRepo.set(r, [...(byRepo.get(r) ?? []), c.path]);
    }
    for (const [r, paths] of byRepo) await r.batch(() => addFiles(r, paths, true));
  });
  ctx.command('rebased.addToGitignore', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    for (const u of targets) {
      const repo = ctx.repos.getForFile(u.fsPath);
      if (!repo) continue;
      addToGitignore(repo, [repo.relPath(u.fsPath)]);
      await repo.refresh();
    }
  });
  ctx.command('rebased.showLocalDiff', async (uri?: vscode.Uri) => {
    const u = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!u || u.scheme !== 'file') return;
    const repo = ctx.repos.getForFile(u.fsPath);
    if (!repo) return;
    const rel = repo.relPath(u.fsPath);
    const c = [...repo.status.changes, ...repo.status.unversioned].find(x => x.path === rel) ?? { root: repo.root, path: rel, status: 'M' as const };
    await openChangeDiff(c, repo.info.empty ? REV_EMPTY : 'HEAD', 'WORKTREE');
  });
  ctx.command('rebased.shelve', async (uri?: unknown, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    const keys = isUriArg(uri) ? changesFor(uri, uris).map(changeKey) : [];
    if (isUriArg(uri)) view.buildState();
    return view.shelveDialog(keys);
  });
  ctx.command('rebased.shelveSilently', () => view.shelveSilently([]));
  ctx.command('rebased.unshelve', () => view.reveal('shelf'));
  ctx.command('rebased.showShelf', () => view.reveal('shelf'));
  ctx.command('rebased.showStashes', () => view.reveal('stash'));
  ctx.command('rebased.newChangelist', () => view.newChangelist());
  ctx.command('rebased.importPatches', () => view.importPatches());

  ctx.command('rebased.stash', async (a?: { root?: string }) => {
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

  ctx.command('rebased.unstash', async (a?: { root?: string; ref?: string }) => {
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
    void vscode.commands.executeCommand('setContext', 'rebased.hasConflicts', hasConflicts);
  };
  ctx.repos.onDidChangeRepository(updateContext);
}
