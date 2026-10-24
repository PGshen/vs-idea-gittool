import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Change, ChangeStatus } from '../../shared/types';
import { EMPTY_TREE } from './gitOps';
import { createPatchDialog, rebasePatchPaths } from './patchDialog';

/** Create Patch… for commits (log, file history): the Create Patch dialog with the files changed by the commits. */
export async function createPatchFromCommits(ctx: Ctx, root: string, hashes: string[], only?: Change[]) {
  const repo = ctx.repos.get(root);
  if (!repo) throw new Error(vscode.l10n.t('Repository {0} is not available', root));
  // Oldest first: the range is from the parent of the oldest commit to the newest one.
  const order = (await repo.execText(['rev-list', '--no-walk=sorted', '--topo-order', '--reverse', ...hashes], { quiet: true })).split('\n').filter(Boolean);
  const oldest = order[0] ?? hashes[0];
  const newest = order[order.length - 1] ?? hashes[hashes.length - 1];
  const parent = await repo.exec(['rev-parse', '-q', '--verify', `${oldest}^`], { allowFailure: true, quiet: true });
  const base = parent.exitCode === 0 ? parent.stdout.trim() : EMPTY_TREE;
  const out = await repo.execText(['diff', '--name-status', '-z', '-M', base, newest], { quiet: true });
  const parts = out.split('\0');
  const files: (Change & { key: string })[] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    const letter = st[0] as ChangeStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i];
      const p = parts[++i];
      files.push({ root, path: p, oldPath, status: letter, key: p });
    } else {
      const p = parts[++i];
      files.push({ root, path: p, status: letter, key: p });
    }
  }
  const selected = only?.length ? files.filter(f => only.some(c => c.path === f.path)).map(f => f.key) : undefined;
  await createPatchDialog({
    files,
    selected,
    name: hashes.length === 1 ? newest.slice(0, 8) : `${oldest.slice(0, 8)}..${newest.slice(0, 8)}`,
    basePath: root,
    rootLabel: hashes.length === 1 ? vscode.l10n.t('Commit {0}', newest.slice(0, 8)) : vscode.l10n.t('{0} commits', hashes.length),
    produce: async (keys, opts) => {
      const paths = files.filter(f => keys.includes(f.key)).flatMap(f => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
      const patch = await repo.execText(['diff', '--binary', '-M', ...(opts.reverse ? ['-R'] : []), base, newest, '--', ...paths], { quiet: true });
      return rebasePatchPaths(patch, root, opts.basePath);
    },
  });
}
