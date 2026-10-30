import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { GitError } from '../../git/exec';
import { Repository } from '../../git/repository';

/**
 * Git operations used by the ops feature. This module does not show UI: it returns results that
 * the command layer (index.ts) turns into notifications and dialogs, so it can be tested with node:test.
 */

export interface RunOptions {
  progress?: (text: string) => void;
  token?: vscode.CancellationToken;
  env?: Record<string, string>;
}

export type OperationOutcome =
  | { kind: 'success'; output: string }
  /**
   * `handled`: the Conflicts dialog was already shown for them (and the notification about the ones left).
   * `savedChangesKept`: the operation stopped with conflicts, so the changes saved by a smart operation were not restored.
   */
  | { kind: 'conflicts'; output: string; files: string[]; handled?: boolean; savedChangesKept?: boolean }
  /** Local changes (or untracked files) would be overwritten. */
  | { kind: 'localChanges'; output: string; files: string[]; untracked: boolean }
  /** Rebase stopped at an `edit` entry. */
  | { kind: 'stopped'; output: string }
  | { kind: 'error'; output: string; error: GitError };

/** Environment for non-interactive git: never open an editor. */
export function nonInteractiveEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { GIT_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no', GIT_SEQUENCE_EDITOR: ':', ...extra };
}

const progressRe = /^(remote: )?([A-Za-z ]+):\s+(\d+)%/;

/** Turns git `--progress` stderr lines into short progress texts. */
export function progressText(line: string): string | undefined {
  const m = progressRe.exec(line.trim());
  if (m) return `${m[2]}: ${m[3]}%`;
  return undefined;
}

export async function conflictedFiles(repo: Repository): Promise<string[]> {
  const r = await repo.exec(['diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true, quiet: true });
  return r.stdout.split('\0').filter(Boolean);
}

/** Parses "Your local changes to the following files would be overwritten by X:" lists. */
export function parseOverwrittenFiles(stderr: string): { files: string[]; untracked: boolean } | undefined {
  const m = /(Your local changes to the following files would be overwritten|The following untracked working tree files would be (?:overwritten|removed)) by [^:\n]+:\n((?:\t.*\n?)+)/.exec(stderr);
  if (!m) return undefined;
  const files = m[2]
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return { files, untracked: m[1].startsWith('The following untracked') };
}

/**
 * Runs an operation that may stop with conflicts (merge, rebase, cherry-pick, revert, pull, stash pop)
 * and classifies the result.
 */
export async function runConflictAware(repo: Repository, args: string[], opts: RunOptions = {}): Promise<OperationOutcome> {
  const r = await repo.exec(args, {
    allowFailure: true,
    env: nonInteractiveEnv(opts.env),
    token: opts.token,
    onStderrLine: opts.progress ? l => {
      const t = progressText(l);
      if (t) opts.progress!(t);
    } : undefined,
  });
  const output = (r.stdout + '\n' + r.stderr).trim();
  if (r.exitCode === 0) {
    if ((args[0] === 'rebase' || args[0] === 'pull') && repo.detectOperation() === 'rebase') return { kind: 'stopped', output };
    return { kind: 'success', output };
  }
  const overwritten = parseOverwrittenFiles(r.stderr);
  if (overwritten) return { kind: 'localChanges', output, ...overwritten };
  const files = await conflictedFiles(repo);
  if (files.length > 0 || /CONFLICT|Merge conflict|could not apply|after resolving the conflicts/i.test(output)) return { kind: 'conflicts', output, files };
  if (repo.detectOperation() === 'rebase' && /Stopped at/.test(output)) return { kind: 'stopped', output };
  return { kind: 'error', output, error: new GitError(r.stderr.trim() || r.stdout.trim() || translate('git {0} failed', args[0]), args, r.exitCode, r.stdout, r.stderr) };
}

// ------------------------------------------------------------------ refs

export function isValidBranchName(name: string): string | undefined {
  if (!name.trim()) return translate('Specify name for the new branch');
  if (name === 'HEAD') return translate('HEAD is a reserved keyword');
  // git check-ref-format rules
  if (
    /(^|\/)\./.test(name) ||
    name.includes('..') ||
    /[\x00-\x20~^:?*[\\\x7f]/.test(name) ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.endsWith('.') ||
    name.includes('@{') ||
    name.includes('//') ||
    name.startsWith('/') ||
    name.startsWith('-') ||
    name === '@'
  ) {
    return translate('Branch name {0} is not valid', name);
  }
  return undefined;
}

/** Validates a new branch name against existing refs, like GitNewBranchDialog. */
export function validateNewBranch(repo: Repository, name: string, overwrite: boolean): string | undefined {
  const invalid = isValidBranchName(name);
  if (invalid) return invalid;
  const locals = repo.refs.filter(r => r.type === 'local');
  if (!overwrite && locals.some(r => r.name === name)) return translate('Branch name {0} already exists', name);
  if (repo.refs.some(r => r.type === 'remote' && r.name === name)) return translate('Branch name {0} conflicts with remote branch with the same name', name);
  if (locals.some(r => r.name.startsWith(name + '/'))) return translate('Branch name {0} conflicts with local branch directory with the same name', name);
  if (locals.some(r => name.startsWith(r.name + '/'))) return translate('Branch name {0} conflicts with local branch with the same name', name);
  return undefined;
}

export async function revParse(repo: Repository, rev: string): Promise<string | undefined> {
  const r = await repo.exec(['rev-parse', '--verify', '-q', `${rev}^{commit}`], { allowFailure: true, quiet: true });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

export async function countCommits(repo: Repository, range: string): Promise<number> {
  const r = await repo.exec(['rev-list', '--count', range], { allowFailure: true, quiet: true });
  return r.exitCode === 0 ? +r.stdout.trim() : 0;
}

export async function isAncestor(repo: Repository, a: string, b: string): Promise<boolean> {
  const r = await repo.exec(['merge-base', '--is-ancestor', a, b], { allowFailure: true, quiet: true });
  return r.exitCode === 0;
}

// ------------------------------------------------------------------ checkout

export async function checkout(
  repo: Repository,
  ref: string,
  opts: { force?: boolean; newBranch?: string; overwrite?: boolean; track?: boolean; ignoreOtherWorktrees?: boolean } & RunOptions = {},
): Promise<OperationOutcome> {
  const args = ['checkout'];
  if (opts.force) args.push('--force');
  if (opts.ignoreOtherWorktrees) args.push('--ignore-other-worktrees');
  if (opts.newBranch) args.push(opts.overwrite ? '-B' : '-b', opts.newBranch);
  if (opts.track === false) args.push('--no-track');
  args.push(ref, '--');
  return runConflictAware(repo, args, opts);
}

// ------------------------------------------------------------------ preserving local changes

/**
 * Saves and restores local changes around an operation, like IntelliJ's GitPreservingProcess with the
 * "Clean working tree using Stash / Shelve" setting. `save` returns false when there was nothing to save.
 */
export interface ChangesSaver {
  readonly method: 'stash' | 'shelve';
  save(repo: Repository, reason: string): Promise<boolean>;
  /** Restores the saved changes; 'conflicts' leaves them partly applied. */
  restore(repo: Repository): Promise<OperationOutcome>;
}

/** Stash-based saver (git stash push / stash pop --index). */
export class StashSaver implements ChangesSaver {
  readonly method = 'stash' as const;
  private hash: string | undefined;

  constructor(private readonly includeUntracked = false) {}

  async save(repo: Repository, reason: string): Promise<boolean> {
    const msg = `Uncommitted changes before ${reason} at ${new Date().toLocaleString()}`;
    const args = ['stash', 'push', ...(this.includeUntracked ? ['--include-untracked'] : []), '-m', msg];
    const r = await repo.exec(args, { allowFailure: true });
    if (r.exitCode !== 0) throw new GitError(r.stderr.trim() || translate('Could not stash local changes'), args, r.exitCode, r.stdout, r.stderr);
    if (/No local changes to save/.test(r.stdout + r.stderr)) return false;
    this.hash = (await revParse(repo, 'refs/stash')) ?? undefined;
    return true;
  }

  async restore(repo: Repository): Promise<OperationOutcome> {
    // Find our entry: other stashes could have been created meanwhile.
    let ref = 'stash@{0}';
    if (this.hash) {
      const list = await repo.execText(['stash', 'list', '--format=%gd %H'], { quiet: true, allowFailure: true });
      const line = list.split('\n').find(l => l.endsWith(` ${this.hash}`));
      if (line) ref = line.split(' ')[0];
    }
    const pop = await runConflictAware(repo, ['stash', 'pop', '--index', ref]);
    // --index fails when the index cannot be restored; retry without it.
    if (pop.kind === 'error') return runConflictAware(repo, ['stash', 'pop', ref]);
    return pop;
  }
}

/** Does the work tree have tracked changes (or untracked ones, when asked)? */
export async function hasLocalChanges(repo: Repository, includeUntracked = false): Promise<boolean> {
  const r = await repo.exec(['status', '--porcelain', `--untracked-files=${includeUntracked ? 'normal' : 'no'}`], { allowFailure: true, quiet: true });
  return r.stdout.trim().length > 0;
}

/** Smart checkout: save local changes (stash by default), run the operation, restore the changes. */
export async function smartOperation(repo: Repository, op: () => Promise<OperationOutcome>, label: string, saver: ChangesSaver = new StashSaver(true)): Promise<OperationOutcome> {
  let saved: boolean;
  try {
    saved = await saver.save(repo, label);
  } catch (e) {
    const err = e instanceof GitError ? e : new GitError(e instanceof Error ? e.message : String(e), ['stash'], 1, '', '');
    return { kind: 'error', output: err.stderr, error: err };
  }
  const result = await op();
  if (!saved) return result;
  if (result.kind === 'error' || result.kind === 'localChanges') {
    await saver.restore(repo);
    return result;
  }
  // Git cannot apply the saved changes in the middle of a merge, rebase, cherry-pick or revert: like
  // GitPreservingProcess, they stay saved ("Local changes were not restored").
  if (result.kind === 'conflicts' && repo.detectOperation() !== 'none') return { ...result, savedChangesKept: true };
  const restored = await saver.restore(repo);
  if (restored.kind !== 'success') return restored;
  return result;
}

// ------------------------------------------------------------------ push

export interface PushSpec {
  remote: string;
  /** Local ref or commit to push (branch name, or a hash for "Push All up to Here"). */
  source: string;
  /** Target branch name on the remote (without refs/heads/). */
  target: string;
  force?: 'lease' | 'force';
  tags?: 'all' | 'current';
  noVerify?: boolean;
  setUpstream?: boolean;
}

export interface PushRefResult {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

export interface PushOutcome {
  ok: boolean;
  rejected: boolean;
  /** Rejected because the remote has new commits (fetch first / non-fast-forward). */
  needsUpdate: boolean;
  refs: PushRefResult[];
  output: string;
  error?: GitError;
}

/** Parses `git push --porcelain` stdout. */
export function parsePushPorcelain(stdout: string): PushRefResult[] {
  const out: PushRefResult[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const [from, to] = m[2].split(':');
    out.push({ flag: m[1], from, to, summary: m[3] });
  }
  return out;
}

export async function push(repo: Repository, spec: PushSpec, opts: RunOptions = {}): Promise<PushOutcome> {
  const args = ['push', '--porcelain', '--progress'];
  if (spec.force === 'lease') args.push('--force-with-lease');
  else if (spec.force === 'force') args.push('--force');
  if (spec.tags === 'all') args.push('--tags');
  else if (spec.tags === 'current') args.push('--follow-tags');
  if (spec.noVerify) args.push('--no-verify');
  if (spec.setUpstream) args.push('--set-upstream');
  const src = spec.source.startsWith('refs/') || /^[0-9a-f]{40}$/.test(spec.source) ? spec.source : `refs/heads/${spec.source}`;
  args.push(spec.remote, `${src}:refs/heads/${spec.target}`);
  const r = await repo.exec(args, {
    allowFailure: true,
    token: opts.token,
    onStderrLine: l => {
      const t = progressText(l);
      if (t && opts.progress) opts.progress(t);
    },
  });
  const refs = parsePushPorcelain(r.stdout);
  const rejected = refs.some(x => x.flag === '!');
  const needsUpdate = refs.some(x => x.flag === '!' && /fetch first|non-fast-forward|stale info/.test(x.summary)) || /\(fetch first\)|\(non-fast-forward\)/.test(r.stderr);
  const ok = r.exitCode === 0 && !rejected;
  return {
    ok,
    rejected: rejected || /\[rejected\]/.test(r.stderr),
    needsUpdate,
    refs,
    output: (r.stdout + '\n' + r.stderr).trim(),
    error: ok ? undefined : new GitError(r.stderr.trim() || translate('Push failed'), args, r.exitCode, r.stdout, r.stderr),
  };
}

/** IntelliJ's success text: "Pushed 1 commit to origin/master", "Pushed master to new branch origin/master". */
export function pushSuccessMessage(spec: PushSpec, commitCount: number, newBranch: boolean, forced: boolean): string {
  const target = `${spec.remote}/${spec.target}`;
  if (newBranch) return translate('Pushed {0} to new branch {1}', spec.source.replace(/^refs\/heads\//, ''), target);
  if (forced) return translate('Force pushed {0} to {1}', spec.source.replace(/^refs\/heads\//, ''), target);
  if (commitCount === 0) return translate('Everything is up to date');
  return commitCount === 1 ? translate('Pushed {0} commit to {1}', commitCount, target) : translate('Pushed {0} commits to {1}', commitCount, target);
}

// ------------------------------------------------------------------ fetch / update

export async function fetch(repo: Repository, remote: string | 'all', opts: RunOptions & { prune?: boolean } = {}): Promise<{ ok: boolean; output: string; error?: GitError }> {
  const args = ['fetch', '--progress'];
  if (opts.prune) args.push('--prune');
  if (remote === 'all') args.push('--all');
  else args.push(remote);
  const r = await repo.exec(args, {
    allowFailure: true,
    token: opts.token,
    onStderrLine: l => {
      const t = progressText(l);
      if (t && opts.progress) opts.progress(t);
    },
  });
  return { ok: r.exitCode === 0, output: r.stderr, error: r.exitCode === 0 ? undefined : new GitError(r.stderr.trim(), args, r.exitCode, r.stdout, r.stderr) };
}

export type UpdateMethod = 'merge' | 'rebase';

export interface UpdateResult {
  outcome: OperationOutcome | { kind: 'skipped'; output: string; reason: string };
  commits: number;
  files: number;
  before?: string;
  after?: string;
  /** Result of restoring local changes saved with `saver`, when they were saved and restored. */
  restore?: OperationOutcome;
  /** The saved changes are still in the stash / shelf (the update stopped, or restoring failed). */
  savedChangesKept?: boolean;
  /** The tracked branch was force-pushed: its previous position is not an ancestor of the fetched one. */
  forcePushed?: { upstream: string; oldHash: string; newHash: string };
}

/**
 * "Update Project" for one repository: fetch the tracked remote, then merge or rebase onto the upstream.
 * With a `saver`, local changes are saved before the update and restored after it, like IntelliJ's
 * GitUpdateProcess; without one, they are kept with `--autostash`.
 */
export async function updateRepository(repo: Repository, method: UpdateMethod, opts: RunOptions & { saver?: ChangesSaver } = {}): Promise<UpdateResult> {
  const upstream = await repo.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true, quiet: true });
  const branch = await repo.exec(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true, quiet: true });
  if (branch.exitCode !== 0) return { outcome: { kind: 'skipped', output: '', reason: 'detached HEAD' }, commits: 0, files: 0 };
  if (upstream.exitCode !== 0) return { outcome: { kind: 'skipped', output: '', reason: 'no tracked branch' }, commits: 0, files: 0 };
  const up = upstream.stdout.trim();
  const upBefore = await revParse(repo, up);
  const remoteName = await repo.getConfig(`branch.${branch.stdout.trim()}.remote`);
  if (remoteName && remoteName !== '.') {
    opts.progress?.(translate('Fetching {0}…', remoteName));
    const f = await fetch(repo, remoteName, opts);
    if (!f.ok) return { outcome: { kind: 'error', output: f.output, error: f.error! }, commits: 0, files: 0 };
  }
  const upAfter = await revParse(repo, up);
  const forcePushed =
    upBefore && upAfter && upBefore !== upAfter && !(await isAncestor(repo, upBefore, upAfter)) ? { upstream: up, oldHash: upBefore, newHash: upAfter } : undefined;
  const before = (await revParse(repo, 'HEAD'))!;
  const incoming = await countCommits(repo, `HEAD..${up}`);
  if (incoming === 0) return { outcome: { kind: 'success', output: '' }, commits: 0, files: 0, before, after: before, forcePushed };
  let saved = false;
  if (opts.saver) {
    opts.progress?.(opts.saver.method === 'shelve' ? translate('Shelving local changes…') : translate('Stashing local changes…'));
    try {
      saved = await opts.saver.save(repo, 'update');
    } catch (e) {
      const err = e instanceof GitError ? e : new GitError(e instanceof Error ? e.message : String(e), ['stash'], 1, '', '');
      return { outcome: { kind: 'error', output: err.message, error: err }, commits: 0, files: 0, before, forcePushed };
    }
  }
  opts.progress?.(method === 'rebase' ? translate('Rebasing onto {0}…', up) : translate('Merging {0}…', up));
  const auto = opts.saver ? [] : ['--autostash'];
  const args = method === 'rebase' ? ['rebase', ...auto, up] : ['merge', ...auto, '--no-edit', up];
  const outcome = await runConflictAware(repo, args, opts);
  const after = (await revParse(repo, 'HEAD')) ?? before;
  let files = 0;
  if (outcome.kind === 'success') {
    const d = await repo.exec(['diff', '--name-only', '-z', before, after], { allowFailure: true, quiet: true });
    files = d.stdout.split('\0').filter(Boolean).length;
  }
  let restore: OperationOutcome | undefined;
  let savedChangesKept = false;
  if (saved && opts.saver) {
    if (outcome.kind === 'conflicts' || outcome.kind === 'stopped') {
      // IntelliJ keeps the changes saved until the merge / rebase is finished.
      savedChangesKept = true;
    } else {
      opts.progress?.(opts.saver.method === 'shelve' ? translate('Unshelving local changes…') : translate('Unstashing local changes…'));
      restore = await opts.saver.restore(repo);
      savedChangesKept = restore.kind === 'error';
    }
  }
  return { outcome, commits: incoming, files, before, after, restore, savedChangesKept, forcePushed };
}

export interface ForcePushedUpdateResult {
  /** 'regular': local merge commits exist, a normal update was done instead (see `update`). */
  result: 'success' | 'nothing' | 'incomplete' | 'error' | 'regular';
  /** Backup branch with the old local commits; kept when not all of them could be cherry-picked. */
  backup?: string;
  error?: GitError;
  update?: UpdateResult;
  cherryPick?: OperationOutcome;
  restore?: OperationOutcome;
}

/**
 * IntelliJ's "Update Force-Pushed Branch" (GitForcePushedBranchUpdateExecutor): back up the current branch,
 * hard-reset it to the fetched tracked branch and cherry-pick the local commits again. With merge commits
 * among the local commits a regular update is done instead.
 */
export async function updateForcePushedBranch(repo: Repository, opts: RunOptions & { saver?: ChangesSaver; method?: UpdateMethod } = {}): Promise<ForcePushedUpdateResult> {
  const branch = (await repo.exec(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true, quiet: true })).stdout.trim();
  const upstream = await repo.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true, quiet: true });
  if (!branch || upstream.exitCode !== 0) return { result: 'nothing' };
  const up = upstream.stdout.trim();
  const remote = await repo.getConfig(`branch.${branch}.remote`);
  if (!remote || remote === '.') return { result: 'nothing' };
  // Local commits relative to the tracked branch as it was known before fetching.
  const log = await repo.execText(['log', '--format=%H %P', `${up}..${branch}`], { quiet: true, allowFailure: true });
  const local = log
    .split('\n')
    .filter(Boolean)
    .map(l => l.split(' '));
  if (local.some(c => c.length > 2)) {
    return { result: 'regular', update: await updateRepository(repo, opts.method ?? 'merge', opts) };
  }
  const backup = local.length ? `${branch}-${randomId()}` : undefined;
  if (backup) await repo.exec(['branch', backup, 'HEAD']);
  opts.progress?.(translate('Fetching {0}…', remote));
  const f = await fetch(repo, remote, opts);
  if (!f.ok) {
    if (backup) await repo.exec(['branch', '-D', backup], { allowFailure: true });
    return { result: 'error', error: f.error };
  }
  let saved = false;
  if (opts.saver) {
    try {
      saved = await opts.saver.save(repo, 'update');
    } catch (e) {
      if (backup) await repo.exec(['branch', '-D', backup], { allowFailure: true });
      return { result: 'error', error: e instanceof GitError ? e : new GitError(String(e), ['stash'], 1, '', '') };
    }
  }
  const reset = await repo.exec(['reset', '--hard', up], { allowFailure: true });
  if (reset.exitCode !== 0) {
    const restore = saved ? await opts.saver!.restore(repo) : undefined;
    return { result: 'error', backup, restore, error: new GitError(reset.stderr.trim(), ['reset', '--hard', up], reset.exitCode, reset.stdout, reset.stderr) };
  }
  let cherryPick: OperationOutcome | undefined;
  if (local.length) {
    opts.progress?.(translate('Cherry-picking local commits…'));
    cherryPick = await runConflictAware(repo, ['cherry-pick', ...local.map(c => c[0]).reverse()], opts);
    if (cherryPick.kind !== 'success') return { result: 'incomplete', backup, cherryPick };
    await repo.exec(['branch', '-D', backup!], { allowFailure: true });
  }
  const restore = saved ? await opts.saver!.restore(repo) : undefined;
  return { result: 'success', cherryPick, restore };
}

/**
 * "Reset to the Remote Branch" of the Update dialog (GitResetUpdater): fetch, then recreate the current
 * branch from its tracked branch (`checkout -B`), dropping local commits.
 */
export async function resetToRemoteBranch(repo: Repository, opts: RunOptions & { force?: boolean } = {}): Promise<{ outcome: OperationOutcome | { kind: 'skipped'; output: string; reason: string }; before?: string; after?: string }> {
  const branch = (await repo.exec(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true, quiet: true })).stdout.trim();
  if (!branch) return { outcome: { kind: 'skipped', output: '', reason: 'detached HEAD' } };
  const upstream = await repo.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true, quiet: true });
  if (upstream.exitCode !== 0) return { outcome: { kind: 'skipped', output: '', reason: 'no tracked branch' } };
  const up = upstream.stdout.trim();
  const remote = await repo.getConfig(`branch.${branch}.remote`);
  if (remote && remote !== '.') {
    opts.progress?.(translate('Fetching {0}…', remote));
    const f = await fetch(repo, remote, opts);
    if (!f.ok) return { outcome: { kind: 'error', output: f.output, error: f.error! } };
  }
  const before = await revParse(repo, 'HEAD');
  const outcome = await checkout(repo, up, { newBranch: branch, overwrite: true, force: opts.force, ...opts });
  if (outcome.kind === 'success') await repo.exec(['branch', '--set-upstream-to', up, branch], { allowFailure: true, quiet: true });
  return { outcome, before, after: await revParse(repo, 'HEAD') };
}

function randomId() {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}`;
}

// ------------------------------------------------------------------ worktrees

export interface Worktree {
  path: string;
  head?: string;
  /** Short branch name, undefined when detached. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
  /** The first entry of `git worktree list` is the main worktree. */
  main: boolean;
}

/** Parses `git worktree list --porcelain` (GitWorktreeListParser). */
export function parseWorktreeList(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length || !lines[0].startsWith('worktree ')) continue;
    const w: Worktree = { path: lines[0].slice(9), bare: false, detached: false, locked: false, prunable: false, main: list.length === 0 };
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) w.head = l.slice(5);
      else if (l.startsWith('branch ')) w.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'bare') w.bare = true;
      else if (l === 'detached') w.detached = true;
      else if (l === 'locked' || l.startsWith('locked ')) {
        w.locked = true;
        w.lockReason = l.slice(7) || undefined;
      } else if (l === 'prunable' || l.startsWith('prunable ')) {
        w.prunable = true;
        w.prunableReason = l.slice(9) || undefined;
      }
    }
    list.push(w);
  }
  return list;
}

export async function listWorktrees(repo: Repository): Promise<Worktree[]> {
  const r = await repo.exec(['worktree', 'list', '--porcelain'], { allowFailure: true, quiet: true });
  return r.exitCode === 0 ? parseWorktreeList(r.stdout) : [];
}

export function samePath(a: string, b: string) {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Worktree other than this repository's own where `branch` is checked out. */
export async function worktreeOfBranch(repo: Repository, branch: string): Promise<Worktree | undefined> {
  const list = await listWorktrees(repo);
  return list.find(w => w.branch === branch && !samePath(w.path, repo.root));
}

export interface CreateWorktreeRequest {
  path: string;
  /** Branch (local or remote), tag or commit to check out; the start point when `newBranch` is set. */
  ref: string;
  newBranch?: string;
  /** Allow a branch that is checked out in another worktree (--force). */
  force?: boolean;
}

export async function createWorktree(repo: Repository, req: CreateWorktreeRequest, opts: RunOptions = {}): Promise<OperationOutcome> {
  const args = ['worktree', 'add'];
  if (req.force) args.push('--force');
  if (req.newBranch) args.push('-b', req.newBranch);
  else if (repo.refs.some(r => r.type === 'remote' && r.name === req.ref) && !repo.refs.some(r => r.type === 'local' && r.name === req.ref)) {
    // A remote branch gets a local tracking branch with the remote name, like IntelliJ's default local branch name.
    const remote = repo.refs.find(r => r.type === 'remote' && r.name === req.ref)!.remote!;
    args.push('--track', '-b', req.ref.slice(remote.length + 1));
  }
  args.push(req.path, req.ref);
  return runConflictAware(repo, args, opts);
}

export async function removeWorktree(repo: Repository, wtPath: string, force = false): Promise<OperationOutcome> {
  return runConflictAware(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
}

export function updateSummary(files: number, commits: number): string {
  if (files === 1) return commits === 1 ? translate('{0} file updated in {1} commit', files, commits) : translate('{0} file updated in {1} commits', files, commits);
  return commits === 1 ? translate('{0} files updated in {1} commit', files, commits) : translate('{0} files updated in {1} commits', files, commits);
}

// ------------------------------------------------------------------ interactive rebase

export type RebaseAction = 'pick' | 'edit' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  hash: string;
  subject: string;
  action: RebaseAction;
  /** New full message for reword, or the combined message for the last commit of a squash group. */
  message?: string;
}

/**
 * Builds a git-rebase-todo for entries in todo order (oldest first). Reword and squash messages
 * are applied with `exec git commit --amend -F <file>` lines, so no editor is needed.
 */
export function buildTodo(entries: RebaseEntry[], msgDir: string): string {
  const lines: string[] = [];
  let i = 0;
  const writeMsg = (msg: string) => {
    const f = path.join(msgDir, `msg-${i++}.txt`);
    fs.writeFileSync(f, msg);
    return `exec git commit --amend --allow-empty --no-verify -F ${shellQuote(f)}`;
  };
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (e.action === 'drop') {
      lines.push(`drop ${e.hash} ${e.subject}`);
      continue;
    }
    const gitAction = e.action === 'reword' ? 'pick' : e.action === 'squash' ? 'fixup' : e.action;
    lines.push(`${gitAction} ${e.hash} ${e.subject}`);
    // A message applies after the last fixup/squash of the group.
    const next = entries.slice(k + 1).find(x => x.action !== 'drop');
    const groupContinues = next && (next.action === 'squash' || next.action === 'fixup');
    if (e.message !== undefined && !groupContinues) lines.push(writeMsg(e.message));
    else if (e.message !== undefined && groupContinues) {
      // Message belongs to the whole group; move it to the group's last entry.
      let last = k + 1;
      while (last + 1 < entries.length && (entries[last + 1].action === 'squash' || entries[last + 1].action === 'fixup' || entries[last + 1].action === 'drop')) last++;
      if (entries[last].message === undefined) entries[last] = { ...entries[last], message: e.message };
    }
  }
  return lines.join('\n') + '\n';
}

function shellQuote(s: string) {
  // git runs exec lines with sh (also on Windows, via Git for Windows' sh).
  return `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes a node script usable as GIT_SEQUENCE_EDITOR. In "replace" mode it replaces git's todo with
 * `todoFile`; in "transform" mode (`todoFile` is JSON {hash: {action, exec}}) it edits git's own todo
 * line by line, which keeps the label/reset/merge lines of --rebase-merges intact.
 */
export function sequenceEditorCommand(todoFile: string, dir: string, mode: 'replace' | 'transform' = 'replace'): { command: string; env: Record<string, string> } {
  const script = path.join(dir, 'sequence-editor.js');
  const body =
    mode === 'replace'
      ? `fs.writeFileSync(target, fs.readFileSync(${JSON.stringify(todoFile)}));`
      : [
          `const map = JSON.parse(fs.readFileSync(${JSON.stringify(todoFile)}, 'utf8'));`,
          'const out = [];',
          "for (const line of fs.readFileSync(target, 'utf8').split('\\n')) {",
          '  const m = /^(pick|p) ([0-9a-f]+)(.*)$/.exec(line);',
          '  const key = m && Object.keys(map).find(h => h.startsWith(m[2]));',
          '  if (!key) { out.push(line); continue; }',
          "  out.push(map[key].action + ' ' + m[2] + m[3]);",
          '  if (map[key].exec) out.push(map[key].exec);',
          '}',
          "fs.writeFileSync(target, out.join('\\n'));",
        ].join('\n');
  fs.writeFileSync(script, `const fs = require('fs');\nconst target = process.argv[process.argv.length - 1];\n${body}\n`);
  const node = process.execPath.replace(/\\/g, '/');
  return { command: `"${node}" "${script.replace(/\\/g, '/')}"`, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function tempDir(prefix = 'ideagittool-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Loads commits from `base` (exclusive) to HEAD in todo order (oldest first). */
export async function loadRebaseCommits(repo: Repository, base: string | undefined): Promise<{ hash: string; subject: string; body: string; author: string; date: number; parents: string[] }[]> {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = await repo.execText(['log', '--reverse', '--topo-order', '--format=%H%x00%P%x00%an%x00%at%x00%s%x00%B%x01', range], { quiet: true });
  return out
    .split('\x01')
    .map(s => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map(rec => {
      const [hash, parents, author, at, subject, body] = rec.split('\0');
      return { hash, parents: parents ? parents.split(' ') : [], author, date: +at, subject, body: body.replace(/\n+$/, '') };
    });
}

/**
 * Runs an interactive rebase onto `base` (or --root) with the given entries (oldest first). The whole todo is
 * replaced, so pass every commit of the range. With `rebaseMerges`, git's todo is edited in place instead
 * (order changes are ignored then).
 */
export async function interactiveRebase(
  repo: Repository,
  base: string | undefined,
  entries: RebaseEntry[],
  opts: RunOptions & { rebaseMerges?: boolean; autostash?: boolean; extraArgs?: string[]; baseArgs?: string[] } = {},
): Promise<OperationOutcome> {
  const dir = tempDir();
  const todo = path.join(dir, 'todo');
  let seq: { command: string; env: Record<string, string> };
  if (opts.rebaseMerges) {
    const map: Record<string, { action: string; exec?: string }> = {};
    let n = 0;
    for (const e of entries) {
      if (e.action === 'pick' && e.message === undefined) continue;
      let exec: string | undefined;
      if (e.message !== undefined) {
        const f = path.join(dir, `msg-${n++}.txt`);
        fs.writeFileSync(f, e.message);
        exec = `exec git commit --amend --allow-empty --no-verify -F ${shellQuote(f)}`;
      }
      map[e.hash] = { action: e.action === 'reword' ? 'pick' : e.action === 'squash' ? 'fixup' : e.action, exec };
    }
    fs.writeFileSync(todo, JSON.stringify(map));
    seq = sequenceEditorCommand(todo, dir, 'transform');
  } else {
    fs.writeFileSync(todo, buildTodo(entries.map(e => ({ ...e })), dir));
    seq = sequenceEditorCommand(todo, dir);
  }
  const args = ['rebase', '--interactive', '--no-autosquash'];
  if (opts.autostash !== false) args.push('--autostash');
  if (opts.rebaseMerges) args.push('--rebase-merges');
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(...(opts.baseArgs ?? [base ?? '--root']));
  return runConflictAware(repo, args, { ...opts, env: { ...seq.env, ...opts.env, GIT_SEQUENCE_EDITOR: seq.command } });
}

/** Finds the rebase base for editing commits: the parent of the oldest one. Undefined means --root. */
export async function rebaseBaseFor(repo: Repository, oldest: string): Promise<string | undefined> {
  const p = await repo.exec(['rev-parse', '-q', '--verify', `${oldest}^`], { allowFailure: true, quiet: true });
  return p.exitCode === 0 ? p.stdout.trim() : undefined;
}

/** Commits from base..HEAD as pick entries; fails when some selected commit is not in the range. */
async function entriesFrom(repo: Repository, oldest: string): Promise<{ base: string | undefined; entries: RebaseEntry[]; bodies: Map<string, string>; hasMerges: boolean }> {
  const base = await rebaseBaseFor(repo, oldest);
  const commits = await loadRebaseCommits(repo, base);
  return {
    base,
    entries: commits.map(c => ({ hash: c.hash, subject: c.subject, action: 'pick' as RebaseAction })),
    bodies: new Map(commits.map(c => [c.hash, c.body])),
    hasMerges: commits.some(c => c.parents.length > 1),
  };
}

/** Oldest of the given commits (the one that is an ancestor of the others). */
export async function oldestOf(repo: Repository, hashes: string[]): Promise<string> {
  let oldest = hashes[0];
  for (const h of hashes.slice(1)) if (await isAncestor(repo, h, oldest)) oldest = h;
  return oldest;
}

/** Sorts commits oldest first: by commit date, then fixed up by ancestry. */
export async function sortOldestFirst(repo: Repository, hashes: string[]): Promise<string[]> {
  if (hashes.length < 2) return hashes;
  const out = await repo.execText(['log', '--no-walk=unsorted', '--format=%H %ct', ...hashes], { quiet: true });
  const dates = new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map(l => [l.split(' ')[0], +l.split(' ')[1]] as [string, number]),
  );
  const list = [...hashes].sort((a, b) => (dates.get(a) ?? 0) - (dates.get(b) ?? 0));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (await isAncestor(repo, list[j], list[i])) [list[i], list[j]] = [list[j], list[i]];
  return list;
}

export async function rewordCommit(repo: Repository, hash: string, message: string, opts: RunOptions = {}): Promise<OperationOutcome> {
  const head = await revParse(repo, 'HEAD');
  const full = (await revParse(repo, hash)) ?? hash;
  if (full === head) {
    return runConflictAware(repo, ['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-m', message], opts);
  }
  const { base, entries, hasMerges } = await entriesFrom(repo, full);
  for (const e of entries) if (e.hash === full) e.message = message;
  return interactiveRebase(repo, base, entries, { ...opts, rebaseMerges: hasMerges });
}

export async function dropCommits(repo: Repository, hashes: string[], opts: RunOptions = {}): Promise<OperationOutcome> {
  const full = await Promise.all(hashes.map(async h => (await revParse(repo, h)) ?? h));
  const oldest = await oldestOf(repo, full);
  const { base, entries, hasMerges } = await entriesFrom(repo, oldest);
  for (const e of entries) if (full.includes(e.hash)) e.action = 'drop';
  return interactiveRebase(repo, base, entries, { ...opts, rebaseMerges: hasMerges });
}

/** Squashes the commits into the oldest one, with a new message. */
export async function squashCommits(repo: Repository, hashes: string[], message: string, opts: RunOptions = {}): Promise<OperationOutcome> {
  const full = await Promise.all(hashes.map(async h => (await revParse(repo, h)) ?? h));
  const oldest = await oldestOf(repo, full);
  const { base, entries, hasMerges } = await entriesFrom(repo, oldest);
  const selected = entries.filter(e => full.includes(e.hash));
  const rest = entries.filter(e => !full.includes(e.hash));
  // Move the selected commits together at the position of the oldest one.
  const idx = entries.findIndex(e => e.hash === oldest);
  const before = entries.slice(0, idx).filter(e => !full.includes(e.hash));
  const after = rest.filter(e => !before.includes(e));
  const group = selected.map((e, i) => ({ ...e, action: (i === 0 ? 'pick' : 'fixup') as RebaseAction }));
  group[group.length - 1].message = message;
  return interactiveRebase(repo, base, [...before, ...group, ...after], { ...opts, rebaseMerges: hasMerges });
}

/**
 * "Fixup…" / "Squash Into…" from the log: commit the staged changes as `fixup!`/`squash!` of the target and autosquash.
 * When there are no staged changes, this reports an error like IntelliJ.
 */
export async function fixupInto(repo: Repository, hash: string, squash: boolean, opts: RunOptions = {}): Promise<OperationOutcome> {
  const commit = await runConflictAware(repo, ['commit', `--${squash ? 'squash' : 'fixup'}=${hash}`, '--no-edit', '--no-verify'], opts);
  if (commit.kind !== 'success') return commit;
  const base = await rebaseBaseFor(repo, (await revParse(repo, hash)) ?? hash);
  return runConflictAware(repo, ['rebase', '--interactive', '--autosquash', '--autostash', base ?? '--root'], { ...opts, env: { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' } });
}

/** Commit messages of the given commits, oldest first (for the squash dialog). */
export async function commitMessages(repo: Repository, hashes: string[]): Promise<{ hash: string; subject: string; body: string; author: string; date: number }[]> {
  const out = await repo.execText(['log', '--no-walk=unsorted', '--format=%H%x00%an%x00%at%x00%s%x00%B%x01', ...hashes], { quiet: true });
  const list = out
    .split('\x01')
    .map(s => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map(rec => {
      const [hash, author, at, subject, body] = rec.split('\0');
      return { hash, author, date: +at, subject, body: body.replace(/\n+$/, '') };
    });
  return list.sort((a, b) => a.date - b.date);
}

/** IntelliJ's GitSquashedCommitsMessage.prettySquash: messages joined by blank lines, fixup!/squash! prefixes removed. */
export function prettySquash(messages: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const clean = m.replace(/^(fixup|squash|amend)! /, '').trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.join('\n\n\n');
}
