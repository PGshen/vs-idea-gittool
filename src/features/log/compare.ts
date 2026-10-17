import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { openChangeDiff, openMultiDiff, REV_EMPTY, toGitUri } from '../../host/gitContent';
import { Ref } from '../../shared/types';
import { EMPTY_TREE, parseNameStatus } from './details';
import { EMPTY_FILTERS } from './filters';
import { fileFromArg } from './util';
import { LogTabState } from './logTab';

function refItems(repo: Repository) {
  const kind = (r: Ref) => (r.type === 'local' ? 'Local' : r.type === 'remote' ? 'Remote' : 'Tags');
  const items: (vscode.QuickPickItem & { ref?: string })[] = [];
  let last = '';
  const sorted = [...repo.refs].sort((a, b) => ['local', 'remote', 'tag'].indexOf(a.type) - ['local', 'remote', 'tag'].indexOf(b.type) || a.name.localeCompare(b.name));
  for (const r of sorted) {
    if (kind(r) !== last) {
      items.push({ label: kind(r), kind: vscode.QuickPickItemKind.Separator });
      last = kind(r);
    }
    items.push({ label: r.name, description: r.current ? 'current' : undefined, ref: r.name, iconPath: new vscode.ThemeIcon(r.type === 'tag' ? 'tag' : 'git-branch') });
  }
  return items;
}

export function registerCompare(ctx: Ctx, openTab: (repo: Repository, state: Partial<LogTabState>) => Promise<unknown>) {
  ctx.command('rebased.compareWithRevision', async (arg?: any) => {
    const f = await fileFromArg(ctx, arg);
    if (!f) return;
    const out = await f.repo.execText(['log', '--follow', '--name-only', '--format=%x01%H%x00%s%x00%an%x00%at', '-n', '500', 'HEAD', '--', f.path], { quiet: true });
    const items = out
      .split('\x01')
      .filter(Boolean)
      .map(rec => {
        const [head, ...files] = rec.split('\n').filter(Boolean);
        const [hash, subject, author, at] = head.split('\0');
        return { label: subject, description: `${hash.slice(0, 8)}  ${author}  ${new Date(+at * 1000).toLocaleString()}`, hash, path: files[0] ?? f.path };
      });
    const picked = await vscode.window.showQuickPick(items, { title: `Compare ${f.path} with Revision`, matchOnDescription: true });
    if (picked) await openChangeDiff({ root: f.repo.root, path: f.path, oldPath: picked.path !== f.path ? picked.path : undefined, status: 'M' }, picked.hash, 'WORKTREE');
  });

  ctx.command('rebased.compareWithBranch', async (arg?: any) => {
    const f = await fileFromArg(ctx, arg);
    if (!f) return;
    const picked = await vscode.window.showQuickPick(refItems(f.repo), { title: `Compare ${f.path} with Branch or Tag`, placeHolder: 'Select branch or tag' });
    if (!picked?.ref) return;
    const exists = (await f.repo.exec(['cat-file', '-e', `${picked.ref}:${f.path}`], { allowFailure: true, quiet: true })).exitCode === 0;
    await openChangeDiff({ root: f.repo.root, path: f.path, status: exists ? 'M' : 'A' }, picked.ref, 'WORKTREE');
  });

  ctx.command('rebased.compareRefs', async (arg?: { root?: string; ref?: string; with?: string }) => {
    await ctx.repos.ready();
    const repo = arg?.root ? ctx.repos.get(arg.root) : await ctx.repos.pick();
    if (!repo) return;
    let ref = arg?.ref;
    if (!ref) {
      const picked = await vscode.window.showQuickPick(refItems(repo), { title: 'Compare with Branch' });
      ref = picked?.ref;
    }
    if (!ref) return;
    const other = arg?.with ?? repo.info.branch ?? 'HEAD';
    await openTab(repo, { mode: 'compare', compare: { ref, with: other }, filters: { ...EMPTY_FILTERS, branches: [`${other}..${ref}`] } });
  });

  ctx.command('rebased.compareRefs.files', async (arg: { root: string; ref: string; with: string }) => {
    const repo = ctx.repos.get(arg.root);
    if (!repo) return;
    const out = await repo.execText(['diff', '--name-status', '-z', '-M', arg.with, arg.ref, '--'], { quiet: true });
    const changes = parseNameStatus(repo.root, out);
    if (!changes.length) {
      void vscode.window.showInformationMessage(`No differences between ${arg.with} and ${arg.ref}`);
      return;
    }
    await openMultiDiff(`${arg.with} ↔ ${arg.ref}`, changes, () => arg.with, () => arg.ref);
  });

  ctx.command('rebased.showCommitDiff', async (arg: { root: string; hash: string; path?: string }) => {
    const repo = ctx.repos.get(arg.root);
    if (!repo) return;
    const parents = (await repo.execText(['rev-parse', `${arg.hash}^@`], { allowFailure: true, quiet: true })).split('\n').filter(Boolean);
    const left = parents[0] ?? EMPTY_TREE;
    const out = await repo.execText(['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', left, arg.hash, '--'], { quiet: true });
    let changes = parseNameStatus(repo.root, out);
    const leftRev = parents[0] ?? REV_EMPTY;
    if (arg.path) {
      changes = changes.filter(c => c.path === arg.path || c.oldPath === arg.path);
      if (changes.length) return openChangeDiff(changes[0], leftRev, arg.hash);
      void vscode.window.showInformationMessage(`${arg.path} was not changed in ${arg.hash.slice(0, 8)}`);
      return;
    }
    await openMultiDiff(arg.hash.slice(0, 8), changes, () => leftRev, () => arg.hash);
  });

  ctx.command('rebased.showRepositoryAtRevision', async (arg: { root: string; hash: string }) => {
    const repo = ctx.repos.get(arg.root);
    if (!repo) return;
    const out = await repo.execText(['ls-tree', '-r', '-z', '--name-only', arg.hash], { quiet: true });
    const files = out.split('\0').filter(Boolean);
    const picked = await vscode.window.showQuickPick(
      files.map(f => ({ label: f.slice(f.lastIndexOf('/') + 1), description: f, resourceUri: vscode.Uri.file(repo.absPath(f)), path: f })),
      { title: `Repository at ${arg.hash.slice(0, 8)}`, matchOnDescription: true, canPickMany: false },
    );
    if (picked) await vscode.window.showTextDocument(toGitUri(repo.root, picked.path, arg.hash), { preview: false });
  });
}
