import { splitNul } from '../../git/exec';
import { Repository } from '../../git/repository';
import { Change, ChangeStatus, CommitDetails } from '../../shared/types';
import { parseLogRecord, LOG_FORMAT } from '../../git/logStream';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Full details (message body, signature) of commits. */
export async function loadDetails(repo: Repository, hashes: string[]): Promise<CommitDetails[]> {
  if (!hashes.length) return [];
  const fmt = LOG_FORMAT.replace('%x01', '') + '%x00%B%x00%G?%x00%GS%x01';
  const out = await repo.execText(['show', '-s', '--decorate=full', `--format=${fmt}`, ...hashes, '--'], { quiet: true });
  return out
    .split('\x01')
    .filter(r => r.trim())
    .map(rec => {
      const r = rec.replace(/^\n/, '');
      const f = r.split('\0');
      const base = parseLogRecord(repo.root, f.slice(0, 10).join('\0'))!;
      return { ...base, body: (f[10] ?? '').replace(/\n+$/, ''), signature: f[11] || undefined, signer: f[12] || undefined };
    });
}

/** Parses `--name-status -z` output. */
export function parseNameStatus(root: string, out: string): Change[] {
  const parts = splitNul(out);
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    const letter = st[0] as ChangeStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i];
      const path = parts[++i];
      changes.push({ root, path, oldPath, status: letter });
    } else {
      const path = parts[++i];
      changes.push({ root, path, status: (letter === 'U' ? 'M' : letter) as ChangeStatus });
    }
  }
  return changes;
}

/**
 * Changes of the selected commits, like the IntelliJ log changes browser:
 * one commit: diff to its first parent; several commits: diff from the parent of the oldest to the newest.
 * `hashes` are ordered newest first. Returns the left revision used for diffs.
 */
export async function loadChanges(repo: Repository, hashes: string[], parentsOf: (h: string) => string[] | undefined): Promise<{ changes: Change[]; left: string; right: string }> {
  const newest = hashes[0];
  const oldest = hashes[hashes.length - 1];
  const parents = parentsOf(oldest) ?? (await repo.execText(['rev-parse', `${oldest}^@`], { allowFailure: true, quiet: true })).split('\n').filter(Boolean);
  const left = parents[0] ?? EMPTY_TREE;
  const out = await repo.execText(['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', left, newest, '--'], { quiet: true });
  return { changes: parseNameStatus(repo.root, out), left, right: newest };
}

/** Changes of a merge commit to each parent ("Show Changes to Parents"). */
export async function loadChangesToParents(repo: Repository, hash: string, parents: string[]) {
  const result: { parent: string; changes: Change[] }[] = [];
  for (const p of parents) {
    const out = await repo.execText(['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', p, hash, '--'], { quiet: true });
    result.push({ parent: p, changes: parseNameStatus(repo.root, out) });
  }
  return result;
}

/** Branches that contain a commit ("In N branches: ..."). */
export async function containingBranches(repo: Repository, hash: string): Promise<string[]> {
  const out = await repo.execText(['branch', '-a', '--contains', hash, '--format=%(refname)'], { allowFailure: true, quiet: true });
  return out
    .split('\n')
    .filter(Boolean)
    .filter(r => !/^refs\/remotes\/[^/]+\/HEAD$/.test(r))
    .map(r => r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''));
}
