import { splitNul } from '../../git/exec';
import { Repository } from '../../git/repository';
import { Change, ChangeStatus } from '../../shared/types';

/** Files changed by each commit (against its first parent), tagged with the commit hash. */
export async function commitChanges(repo: Repository, hashes: string[]): Promise<(Change & { hash: string })[]> {
  const out: (Change & { hash: string })[] = [];
  for (const hash of hashes) {
    const text = await repo.execText(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', '--root', '-m', '--first-parent', hash], { quiet: true });
    out.push(...parseNameStatus(repo.root, text).map(c => ({ ...c, hash })));
  }
  // Collapse repeated paths when several commits are selected: the newest change wins.
  const seen = new Map<string, Change & { hash: string }>();
  for (const c of out) if (!seen.has(c.path)) seen.set(c.path, c);
  return [...seen.values()];
}

/** Changes between a ref and the working tree / another ref. */
export async function diffChanges(repo: Repository, from: string, to?: string): Promise<Change[]> {
  const args = ['diff', '--name-status', '-z', '-M', from];
  if (to) args.push(to);
  return parseNameStatus(repo.root, await repo.execText(args, { quiet: true }));
}

export function parseNameStatus(root: string, text: string): Change[] {
  const parts = splitNul(text);
  const out: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    const letter = st[0] as ChangeStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i];
      const path = parts[++i];
      out.push({ root, path, oldPath, status: letter });
    } else {
      const path = parts[++i];
      if (path === undefined) break;
      out.push({ root, path, status: (['M', 'A', 'D', 'T', 'U'].includes(letter) ? letter : 'M') as ChangeStatus });
    }
  }
  return out;
}
