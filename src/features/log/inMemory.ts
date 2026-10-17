import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { splitNul } from '../../git/exec';
import { Repository } from '../../git/repository';

/**
 * In-memory commit editing, like IntelliJ's GitInMemoryCommitEditingOperation: new commits are built with
 * `commit-tree` and `merge-tree` without touching the working tree, then HEAD is moved.
 * Used by "Drop Selected Changes", "Extract Selected Changes to Separate Commit…" and
 * "Add Commits to Remote Branch…".
 */

export const REFLOG_SUFFIX = 'by Rebased';

export class InMemoryError extends Error {}

export class MergeConflictError extends InMemoryError {
  constructor(readonly files: string[]) {
    super(`Merge conflict in ${files.join(', ')}`);
  }
}

export interface CommitInfo {
  hash: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Raw author date ("<unix> <tz>"). */
  authorDate: string;
  message: string;
}

export async function commitInfo(repo: Repository, hash: string): Promise<CommitInfo> {
  const out = await repo.execText(['show', '-s', '--date=raw', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%ad%x00%B', hash, '--'], { quiet: true });
  const [h, tree, parents, authorName, authorEmail, authorDate, ...msg] = out.split('\0');
  return { hash: h, tree, parents: parents ? parents.split(' ') : [], authorName, authorEmail, authorDate, message: msg.join('\0').replace(/\n$/, '') };
}

/** Creates a commit object keeping the author of `base` (GitObjectRepository.commitTreeWithOverrides). */
export async function commitTree(repo: Repository, tree: string, parents: string[], message: string, author: Pick<CommitInfo, 'authorName' | 'authorEmail' | 'authorDate'>): Promise<string> {
  const args = ['commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-F', '-');
  const out = await repo.execText(args, {
    input: message.endsWith('\n') ? message : message + '\n',
    env: { GIT_AUTHOR_NAME: author.authorName, GIT_AUTHOR_EMAIL: author.authorEmail, GIT_AUTHOR_DATE: author.authorDate },
    quiet: true,
  });
  return out.trim();
}

export async function treeOf(repo: Repository, rev: string): Promise<string> {
  return (await repo.execText(['rev-parse', `${rev}^{tree}`], { quiet: true })).trim();
}

/**
 * Applies the changes of `commit` (relative to its first parent) on top of `onto`.
 * Returns the new commit, or null when the changes are already present (empty result).
 */
export async function cherryPickInMemory(repo: Repository, commit: CommitInfo, onto: string): Promise<string | null> {
  if (commit.parents.length > 1) throw new InMemoryError(`Commit ${commit.hash.slice(0, 8)} is a merge commit`);
  const ontoTree = await treeOf(repo, onto);
  let tree: string;
  if (!commit.parents.length) {
    tree = commit.tree;
  } else if ((await treeOf(repo, commit.parents[0])) === ontoTree) {
    // Same base: the result is the commit's own tree.
    tree = commit.tree;
  } else {
    const r = await repo.exec(['merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${commit.parents[0]}`, onto, commit.hash], { allowFailure: true, quiet: true });
    if (r.exitCode === 1) {
      const parts = splitNul(r.stdout);
      throw new MergeConflictError(parts.slice(1).filter(p => p && !p.includes('\n')));
    }
    if (r.exitCode !== 0) throw new InMemoryError(r.stderr.trim() || 'merge-tree failed');
    tree = splitNul(r.stdout)[0].trim();
  }
  if (tree === ontoTree) return null;
  return commitTree(repo, tree, [onto], commit.message, commit);
}

/**
 * Commits from `base` (inclusive) to HEAD, oldest first. Fails when the range is not linear or `base`
 * is not in the current branch.
 */
export async function rangeToHead(repo: Repository, base: string): Promise<CommitInfo[]> {
  const head = repo.info.headHash;
  if (!head) throw new InMemoryError('The repository has no commits');
  const isAncestor = (await repo.exec(['merge-base', '--is-ancestor', base, 'HEAD'], { allowFailure: true, quiet: true })).exitCode === 0;
  if (!isAncestor) throw new InMemoryError(`Commit ${base.slice(0, 8)} is not in the current branch`);
  const info = await commitInfo(repo, base);
  const rest = (await repo.execText(['rev-list', '--reverse', '--parents', `${base}..HEAD`], { quiet: true })).split('\n').filter(Boolean);
  const out = [info];
  let prev = info.hash;
  for (const line of rest) {
    const [h, ...parents] = line.split(' ');
    if (parents.length !== 1 || parents[0] !== prev) throw new InMemoryError('Commits after the selected one contain merges, so they can not be rewritten in memory');
    out.push(await commitInfo(repo, h));
    prev = h;
  }
  return out;
}

/**
 * Tree of `tree` with `paths` reverted to their state in `from` (or removed when `from` lacks them).
 * Uses a temporary index, so the real index is not touched.
 */
export async function treeWithPathsFrom(repo: Repository, tree: string, from: string | undefined, paths: string[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebased-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    await repo.exec(['read-tree', tree], { env, quiet: true });
    const entries = new Map<string, string>();
    if (from) {
      const ls = await repo.execText(['ls-tree', '-r', '-z', '--full-tree', from, '--', ...paths], { quiet: true });
      for (const e of splitNul(ls)) {
        const tab = e.indexOf('\t');
        const [mode, , sha] = e.slice(0, tab).split(' ');
        entries.set(e.slice(tab + 1), `${mode} ${sha}`);
      }
    }
    const lines = paths.map(p => `${entries.get(p) ?? '0 0000000000000000000000000000000000000000'}\t${p}`);
    await repo.exec(['update-index', '-z', '--index-info'], { env, input: lines.join('\0') + '\0', quiet: true });
    return (await repo.execText(['write-tree'], { env, quiet: true })).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Re-creates `commits` on top of `base`, oldest first. Returns the new head and old -> new pairs. */
export async function chainCommits(repo: Repository, base: string, commits: CommitInfo[]): Promise<{ head: string; rewritten: [string, string][] }> {
  let head = base;
  const rewritten: [string, string][] = [];
  for (const c of commits) {
    const n = await cherryPickInMemory(repo, c, head);
    // A commit that becomes empty is kept, like IntelliJ (the user did not ask to drop it).
    head = n ?? (await commitTree(repo, await treeOf(repo, head), [head], c.message, c));
    rewritten.push([c.hash, head]);
  }
  return { head, rewritten };
}

/**
 * Moves the current branch from `oldHead` to `newHead`. With `workingTree`, index and files are updated
 * like `git reset --keep`; local changes in other files are kept.
 */
export async function moveHead(repo: Repository, oldHead: string, newHead: string, operation: string, workingTree: boolean) {
  const current = (await repo.execText(['rev-parse', 'HEAD'], { quiet: true })).trim();
  if (current !== oldHead) throw new InMemoryError('HEAD moved during the commit editing operation');
  const reflog = `${operation} ${REFLOG_SUFFIX}`;
  if (!workingTree) {
    await repo.exec(['update-ref', '-m', reflog, 'HEAD', newHead, oldHead]);
    return;
  }
  const r = await repo.exec(['reset', '--keep', newHead], { allowFailure: true, env: { GIT_REFLOG_ACTION: reflog } });
  if (r.exitCode === 0) return;
  // Local changes touch the rewritten files: keep them aside like GitPreservingProcess.
  const stash = await repo.exec(['stash', 'push', '--include-untracked', '-m', `Uncommitted changes before ${operation}`], { allowFailure: true });
  if (stash.exitCode !== 0) throw new InMemoryError(r.stderr.trim() || stash.stderr.trim());
  await repo.exec(['reset', '--hard', newHead], { env: { GIT_REFLOG_ACTION: reflog } });
  const pop = await repo.exec(['stash', 'pop', '--index'], { allowFailure: true });
  if (pop.exitCode !== 0) throw new InMemoryError(`Local changes were stashed but could not be restored automatically: ${pop.stderr.trim()}`);
}

function pathsOf(changes: { path: string; oldPath?: string }[]): string[] {
  return [...new Set(changes.flatMap(c => (c.oldPath ? [c.oldPath, c.path] : [c.path])))];
}

export interface EditResult {
  oldHead: string;
  newHead: string;
  /** Commit to select in the log. */
  focus: string;
  workingTree: boolean;
}

/** "Drop Selected Changes": removes the changes of some files from a commit of the current branch. */
export async function dropSelectedChanges(repo: Repository, hash: string, changes: { path: string; oldPath?: string }[]): Promise<EditResult> {
  const oldHead = repo.info.headHash!;
  const [target, ...rest] = await rangeToHead(repo, hash);
  if (target.parents.length > 1) throw new InMemoryError('Changes of a merge commit can not be dropped');
  const tree = await treeWithPathsFrom(repo, target.tree, target.parents[0], pathsOf(changes));
  const rewritten = await commitTree(repo, tree, target.parents, target.message, target);
  const { head } = await chainCommits(repo, rewritten, rest);
  await moveHead(repo, oldHead, head, 'drop selected changes', true);
  return { oldHead, newHead: head, focus: rewritten, workingTree: true };
}

/**
 * "Extract Selected Changes to Separate Commit…": the commit keeps the other changes and its message;
 * a new commit with `message` and the selected changes follows it. The final tree does not change.
 */
export async function extractSelectedChanges(repo: Repository, hash: string, changes: { path: string; oldPath?: string }[], message: string): Promise<EditResult> {
  const oldHead = repo.info.headHash!;
  const [target, ...rest] = await rangeToHead(repo, hash);
  if (target.parents.length > 1) throw new InMemoryError('Changes of a merge commit can not be extracted');
  const remaining = await treeWithPathsFrom(repo, target.tree, target.parents[0], pathsOf(changes));
  const first = await commitTree(repo, remaining, target.parents, target.message, target);
  const second = await commitTree(repo, target.tree, [first], message, target);
  let head = second;
  for (const c of rest) head = await commitTree(repo, c.tree, [head], c.message, c);
  await moveHead(repo, oldHead, head, 'extract selected changes', false);
  return { oldHead, newHead: head, focus: second, workingTree: false };
}

/** Undo of an in-memory edit, while HEAD still points at the result. */
export async function undoEdit(repo: Repository, r: EditResult, operation: string) {
  await moveHead(repo, r.newHead, r.oldHead, `undo ${operation}`, r.workingTree);
}

/**
 * "Add Commits to Remote Branch…": fetches the branch, cherry-picks the commits (oldest first) onto it in
 * memory and returns the new tip, or null when all commits are already present.
 */
export async function addCommitsToRemoteBranch(repo: Repository, hashes: string[], remote: string, branch: string, progress?: (text: string) => void): Promise<string | null> {
  progress?.('Fetching remote branch…');
  await repo.exec(['fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const tip = (await repo.execText(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`], { quiet: true })).trim();
  progress?.('Cherry-picking commits in memory…');
  let base = tip;
  for (const h of hashes) {
    const n = await cherryPickInMemory(repo, await commitInfo(repo, h), base);
    if (n) base = n;
  }
  return base === tip ? null : base;
}
