import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../../git/repository';
import { Change } from '../../shared/types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface CommitOptions {
  amend: boolean;
  /** "Name <email>" override. */
  author?: string;
  signOff: boolean;
  gpgSign: boolean;
  /** Run Git hooks (when false, --no-verify). */
  runHooks: boolean;
  /** Commit renames separately first ("Create extra commit with file movements"). */
  extraMoveCommit?: boolean;
}

function nulList(paths: string[]) {
  return paths.join('\0') + '\0';
}

function tmpFile(prefix: string, content?: string | Buffer) {
  const f = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
}

/** All paths touched by the changes (both sides of renames). */
export function changePaths(changes: Change[]): string[] {
  const set = new Set<string>();
  for (const c of changes) {
    set.add(c.path);
    if (c.oldPath) set.add(c.oldPath);
  }
  return [...set];
}

/** Adds files to git (Add to VCS). */
export async function addFiles(repo: Repository, paths: string[], force = false) {
  if (!paths.length) return;
  await repo.exec(['add', ...(force ? ['-f'] : []), '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) });
}

/**
 * Commits exactly the given changes, like IntelliJ with the staging area disabled:
 * unversioned files are added, then `git commit --only` takes the work tree state of the paths.
 * During a merge a partial commit is impossible, so the paths are staged and the whole index is committed.
 */
export async function commitChanges(repo: Repository, changes: Change[], message: string, opts: CommitOptions): Promise<void> {
  const toAdd = changes.filter(c => c.status === '?' || c.status === 'U').map(c => c.path);
  let paths = changePaths(changes);
  const merging = repo.detectOperation() === 'merge' || repo.detectOperation() === 'cherry-pick' || repo.detectOperation() === 'revert';
  await addFiles(repo, toAdd, true);
  if (opts.extraMoveCommit && !merging && !opts.amend && (await commitMovements(repo, changes))) {
    // The old paths are gone from HEAD now; only the new paths remain to commit.
    paths = [...new Set(changes.map(c => c.path))];
  }
  const msgFile = tmpFile('rebased-commit-msg', message);
  try {
    const args = ['commit', '-F', msgFile];
    if (opts.amend) args.push('--amend');
    if (opts.author) args.push(`--author=${opts.author}`);
    if (opts.signOff) args.push('--signoff');
    if (opts.gpgSign) args.push('-S');
    if (!opts.runHooks) args.push('--no-verify');
    if (merging) {
      if (paths.length) await repo.exec(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) });
      await repo.exec(args);
    } else if (paths.length) {
      args.push('--only', '--pathspec-from-file=-', '--pathspec-file-nul');
      await repo.exec(args, { input: nulList(paths) });
    } else {
      // Amend of the message only.
      args.push('--only');
      if (!opts.amend) args.push('--allow-empty');
      await repo.exec(args);
    }
  } finally {
    fs.rmSync(msgFile, { force: true });
  }
}

/**
 * Commits only the file movements (old content at the new path), so that history follows renames
 * even when the moved files were also changed. The real index keeps the rest of the changes.
 */
export async function commitMovements(repo: Repository, changes: Change[]): Promise<boolean> {
  const renames = changes.filter(c => c.status === 'R' && c.oldPath);
  if (!renames.length || !(await hasHead(repo))) return false;
  const index = tmpFile('rebased-move-index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await repo.exec(['read-tree', 'HEAD'], { env, quiet: true });
    let info = '';
    for (const c of renames) {
      const ls = (await repo.exec(['ls-tree', 'HEAD', '--', c.oldPath!], { quiet: true })).stdout.trim();
      const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(ls);
      if (!m) continue;
      info += `0 ${'0'.repeat(40)}\t${c.oldPath}\n${m[1]} ${m[2]}\t${c.path}\n`;
    }
    if (!info) return false;
    await repo.exec(['update-index', '--index-info'], { env, input: info, quiet: true });
    const tree = (await repo.exec(['write-tree'], { env, quiet: true })).stdout.trim();
    const n = renames.length;
    const commit = (await repo.exec(['commit-tree', tree, '-p', 'HEAD', '-m', `Move ${n === 1 ? '1 file' : `${n} files`}`])).stdout.trim();
    await repo.exec(['update-ref', '-m', 'commit: move files', 'HEAD', commit]);
    return true;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Amends an older commit of the current branch: fixup commit + autosquash rebase. */
export async function amendSpecificCommit(repo: Repository, hash: string, changes: Change[], message: string, opts: CommitOptions) {
  await commitChanges(repo, changes, `amend! ${hash}\n\n${message}`, { ...opts, amend: false });
  await repo.exec(['-c', 'sequence.editor=:', 'rebase', '-i', '--autosquash', '--autostash', `${hash}~1`], {
    env: { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' },
  });
}

export async function lastCommitMessage(repo: Repository, hash = 'HEAD'): Promise<string> {
  const r = await repo.exec(['log', '-1', '--format=%B', hash], { allowFailure: true, quiet: true });
  return r.exitCode === 0 ? r.stdout.replace(/\s+$/, '') : '';
}

async function hasHead(repo: Repository) {
  return (await repo.exec(['rev-parse', '-q', '--verify', 'HEAD'], { allowFailure: true, quiet: true })).exitCode === 0;
}

/**
 * Reverts changes to HEAD (Rollback). Added files are unversioned again, and deleted from disk when `deleteAdded`.
 * Moved files go back to their old path.
 */
export async function rollbackChanges(repo: Repository, changes: Change[], deleteAdded: boolean) {
  const head = await hasHead(repo);
  const restore: string[] = [];
  const unstage: string[] = [];
  const remove: string[] = [];
  for (const c of changes) {
    if (c.status === '?' || c.status === '!') continue;
    const added = !head || c.status === 'A' || c.status === 'C' || (c.status === 'U' && (c.index === 'A' || c.workTree === 'A') && c.index !== 'U');
    if (c.status === 'R' && c.oldPath) {
      restore.push(c.oldPath);
      unstage.push(c.path);
      remove.push(c.path);
    } else if (added) {
      unstage.push(c.path);
      if (deleteAdded) remove.push(c.path);
    } else restore.push(c.path);
  }
  if (unstage.length) {
    await repo.exec(['rm', '--cached', '-q', '-f', '-r', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(unstage) });
  }
  if (restore.length) {
    await repo.exec(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(restore) });
  }
  for (const p of remove) fs.rmSync(repo.absPath(p), { force: true });
}

/** Deletes unversioned files from disk. */
export function deleteFiles(repo: Repository, paths: string[]) {
  for (const p of paths) fs.rmSync(repo.absPath(p), { force: true, recursive: true });
}

export interface PatchFile {
  path: string;
  oldPath?: string;
  status: Change['status'];
  /** Blob of the base version (HEAD), when any. */
  oldBlob?: string;
  /** Blob of the changed version, when any. */
  newBlob?: string;
  binary?: boolean;
}

/**
 * Builds a binary patch of the given changes against HEAD, including unversioned files, without touching
 * the real index (a temporary index is used). Returns the patch and per-file blob ids.
 */
export async function createPatch(repo: Repository, changes: Change[]): Promise<{ patch: string; files: PatchFile[] }> {
  const index = tmpFile('rebased-index');
  const env = { GIT_INDEX_FILE: index };
  const head = (await hasHead(repo)) ? 'HEAD' : EMPTY_TREE;
  const paths = changePaths(changes);
  try {
    if (head === 'HEAD') await repo.exec(['read-tree', 'HEAD'], { env, quiet: true });
    else await repo.exec(['read-tree', '--empty'], { env, quiet: true });
    await repo.exec(['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: nulList(paths), quiet: true });
    const patch = (await repo.exec(['diff', '--cached', '--binary', '-M', '--full-index', head, '--', ...paths], { env, quiet: true })).stdout;
    const raw = (await repo.exec(['diff', '--cached', '-M', '--full-index', '--raw', '-z', head, '--', ...paths], { env, quiet: true })).stdout;
    const files: PatchFile[] = [];
    const parts = raw.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const meta = parts[i];
      if (!meta.startsWith(':')) continue;
      const [, , oldSha, newSha, st] = meta.slice(1).split(' ');
      const letter = st[0];
      const zero = /^0+$/;
      if (letter === 'R' || letter === 'C') {
        const oldPath = parts[++i];
        const newPath = parts[++i];
        files.push({ path: newPath, oldPath, status: letter as 'R', oldBlob: oldSha, newBlob: newSha });
      } else {
        const p = parts[++i];
        files.push({
          path: p,
          status: (letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'T' ? 'T' : 'M') as Change['status'],
          oldBlob: zero.test(oldSha) ? undefined : oldSha,
          newBlob: zero.test(newSha) ? undefined : newSha,
        });
      }
    }
    return { patch, files };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Splits a multi-file patch into per-file sections keyed by the new path ("b/" side). */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const sections = patch.split(/^(?=diff --git )/m).filter(s => s.startsWith('diff --git '));
  for (const s of sections) {
    const header = s.slice(0, s.indexOf('\n'));
    out.set(parseDiffHeaderPath(header), s);
  }
  return out;
}

function parseDiffHeaderPath(header: string): string {
  const rest = header.slice('diff --git '.length);
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "b/');
    return unquote(rest.slice(start + 1)).slice(2);
  }
  const i = rest.lastIndexOf(' b/');
  return rest.slice(i + 3);
}

function unquote(s: string) {
  try {
    return JSON.parse(s.replace(/\\([0-7]{3})/g, (_, o) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`));
  } catch {
    return s.slice(1, -1);
  }
}

/**
 * Applies a patch to the work tree only. Falls back to a 3-way merge (which leaves conflicts in the index).
 * New files are added to git, like IntelliJ's unshelve.
 */
export async function applyPatch(repo: Repository, patch: string, files: PatchFile[]): Promise<{ conflicts: boolean }> {
  if (!patch.trim()) return { conflicts: false };
  const f = tmpFile('rebased-patch', patch);
  let conflicts = false;
  try {
    const r = await repo.exec(['apply', '--binary', '--whitespace=nowarn', f], { allowFailure: true });
    if (r.exitCode !== 0) {
      const r3 = await repo.exec(['apply', '--binary', '--3way', '--whitespace=nowarn', f], { allowFailure: true });
      if (r3.exitCode !== 0 && !/conflicts/i.test(r3.stderr)) throw new Error(r3.stderr.trim() || r.stderr.trim());
      conflicts = /conflict/i.test(r3.stderr) || r3.exitCode !== 0;
      // 3-way apply stages clean results: unstage them again, keep new files added.
      const clean = files.filter(x => x.status !== 'A').map(x => x.path);
      if (clean.length && !conflicts) await repo.exec(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(clean), allowFailure: true });
    }
    const added = files.filter(x => x.status === 'A' || x.status === 'C').map(x => x.path);
    const moved = files.filter(x => x.status === 'R').flatMap(x => [x.path, x.oldPath!]);
    if (added.length) await addFiles(repo, added, true).catch(() => undefined);
    if (moved.length) await repo.exec(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(moved), allowFailure: true });
  } finally {
    fs.rmSync(f, { force: true });
  }
  return { conflicts };
}

/** Adds patterns to the .gitignore in the repository root. */
export function addToGitignore(repo: Repository, relPaths: string[]) {
  const file = path.join(repo.root, '.gitignore');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(text.split(/\r?\n/));
  const add = relPaths.map(p => '/' + p.replace(/^\/+/, '')).filter(p => !lines.has(p));
  if (!add.length) return;
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text + add.join('\n') + '\n');
}

export interface StashFile extends Change {
  /** Revision of the left side and right side of the diff. */
  left: string;
  right: string;
}

/** Files changed in a stash, including untracked files saved with -u. */
export async function stashFiles(repo: Repository, hash: string): Promise<StashFile[]> {
  const out = (await repo.exec(['diff', '--name-status', '-z', '-M', `${hash}^1`, hash], { quiet: true })).stdout.split('\0');
  const files: StashFile[] = [];
  for (let i = 0; i < out.length; i++) {
    const st = out[i];
    if (!st) continue;
    const letter = st[0] as Change['status'];
    if (letter === 'R' || letter === 'C') {
      const oldPath = out[++i];
      const p = out[++i];
      files.push({ root: repo.root, path: p, oldPath, status: letter, left: `${hash}^1`, right: hash });
    } else {
      files.push({ root: repo.root, path: out[++i], status: letter, left: `${hash}^1`, right: hash });
    }
  }
  const u = await repo.exec(['ls-tree', '-r', '--name-only', '-z', `${hash}^3`], { allowFailure: true, quiet: true });
  if (u.exitCode === 0) {
    for (const p of u.stdout.split('\0').filter(Boolean)) files.push({ root: repo.root, path: p, status: 'A', left: '', right: `${hash}^3` });
  }
  return files;
}

export type ConflictKind = 'both deleted' | 'both added' | 'both modified' | 'deleted by you' | 'deleted by them' | 'added by you' | 'added by them';

/** Conflict type from the porcelain XY of an unmerged entry ("ours" / "theirs" in git terms). */
export function conflictKind(xy: string): ConflictKind {
  switch (xy) {
    case 'DD':
      return 'both deleted';
    case 'AU':
      return 'added by you';
    case 'UD':
      return 'deleted by them';
    case 'UA':
      return 'added by them';
    case 'DU':
      return 'deleted by you';
    case 'AA':
      return 'both added';
    default:
      return 'both modified';
  }
}

/**
 * "Resolve All Simple Conflicts": merges the three stages with `git merge-file`; when there are no
 * conflicting hunks, writes the result and stages the file. Returns true when the file was resolved.
 */
export async function resolveSimpleConflict(repo: Repository, c: Change): Promise<boolean> {
  if (`${c.index}${c.workTree}` !== 'UU') return false;
  const stages = await Promise.all([':1', ':2', ':3'].map(s => repo.show(s, c.path)));
  if (stages.some(b => b.includes(0))) return false;
  const files = stages.map((b, i) => tmpFile(`rebased-merge-${i}`, b));
  try {
    const r = await repo.exec(['merge-file', '-p', files[1], files[0], files[2]], { allowFailure: true, binary: true });
    if (r.exitCode !== 0) return false;
    fs.writeFileSync(repo.absPath(c.path), r.buffer!);
    await addFiles(repo, [c.path], true);
    return true;
  } finally {
    files.forEach(f => fs.rmSync(f, { force: true }));
  }
}

/** Accepts one side for conflicted files. `side` is in git terms (ours / theirs). */
export async function acceptSide(repo: Repository, conflicts: Change[], side: 'ours' | 'theirs') {
  const del: string[] = [];
  const take: string[] = [];
  for (const c of conflicts) {
    const xy = `${c.index}${c.workTree}`;
    const deleted = side === 'ours' ? xy === 'DU' || xy === 'DD' : xy === 'UD' || xy === 'DD';
    (deleted ? del : take).push(c.path);
  }
  if (take.length) {
    await repo.exec(['checkout', `--${side}`, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(take) });
    await addFiles(repo, take, true);
  }
  if (del.length) await repo.exec(['rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(del) });
}
