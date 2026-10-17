import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Change, ChangeStatus, OngoingOperation, Ref, Remote, RepoInfo, Stash } from '../shared/types';
import { ExecOptions, ExecResult, git, splitNul } from './exec';

export interface StatusSnapshot {
  changes: Change[];
  unversioned: Change[];
  ignored: Change[];
  conflicts: Change[];
}

/**
 * Model of one git repository (a VCS root in IntelliJ terms). Holds cached state and fires
 * `onDidChange` when files, refs or the ongoing operation change.
 */
export class Repository implements vscode.Disposable {
  readonly name: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<{ status: boolean; refs: boolean }>();
  /** Fired after a refresh. `refs` is true when branches, tags, HEAD or the operation state changed. */
  readonly onDidChange = this.changeEmitter.event;

  info: RepoInfo;
  status: StatusSnapshot = { changes: [], unversioned: [], ignored: [], conflicts: [] };
  refs: Ref[] = [];
  remotes: Remote[] = [];
  stashes: Stash[] = [];

  private refreshTimer: NodeJS.Timeout | undefined;
  private pendingStatus = false;
  private pendingRefs = false;
  private refreshing: Promise<void> | undefined;
  private suspendDepth = 0;

  constructor(
    readonly root: string,
    readonly gitDir: string,
    readonly commonDir: string,
  ) {
    this.name = path.basename(root);
    this.info = { root, name: this.name, detached: false, operation: 'none', ahead: 0, behind: 0, empty: false, shallow: false };
    this.watch();
  }

  private watch() {
    const gitDirWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.gitDir), '**'));
    const onGitDir = (uri: vscode.Uri) => {
      const rel = path.relative(this.gitDir, uri.fsPath).replace(/\\/g, '/');
      if (rel.endsWith('.lock') || rel.startsWith('objects/') || rel === 'FETCH_HEAD' || rel.startsWith('logs/')) return;
      this.scheduleRefresh(true, true);
    };
    gitDirWatcher.onDidChange(onGitDir, null, this.disposables);
    gitDirWatcher.onDidCreate(onGitDir, null, this.disposables);
    gitDirWatcher.onDidDelete(onGitDir, null, this.disposables);
    this.disposables.push(gitDirWatcher);
    if (this.commonDir !== this.gitDir) {
      const commonWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.commonDir), 'refs/**'));
      const onRefs = () => this.scheduleRefresh(false, true);
      commonWatcher.onDidChange(onRefs, null, this.disposables);
      commonWatcher.onDidCreate(onRefs, null, this.disposables);
      commonWatcher.onDidDelete(onRefs, null, this.disposables);
      this.disposables.push(commonWatcher);
    }
    const wtWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.root), '**'));
    const onWorkTree = (uri: vscode.Uri) => {
      const rel = path.relative(this.root, uri.fsPath).replace(/\\/g, '/');
      if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('..')) return;
      this.scheduleRefresh(true, false);
    };
    wtWatcher.onDidChange(onWorkTree, null, this.disposables);
    wtWatcher.onDidCreate(onWorkTree, null, this.disposables);
    wtWatcher.onDidDelete(onWorkTree, null, this.disposables);
    this.disposables.push(wtWatcher);
  }

  /** Runs git in this repository. */
  exec(args: string[], opts: Omit<ExecOptions, 'cwd'> = {}): Promise<ExecResult> {
    return git(args, { cwd: this.root, ...opts });
  }

  async execText(args: string[], opts: Omit<ExecOptions, 'cwd'> = {}): Promise<string> {
    return (await this.exec(args, opts)).stdout;
  }

  /**
   * Runs `fn` with automatic refresh suspended, then refreshes everything once.
   * Use this for multi-step operations so that the UI does not flicker.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth++;
    try {
      return await fn();
    } finally {
      this.suspendDepth--;
      if (this.suspendDepth === 0) await this.refresh();
    }
  }

  scheduleRefresh(status: boolean, refs: boolean) {
    this.pendingStatus ||= status;
    this.pendingRefs ||= refs;
    if (this.suspendDepth > 0) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.runRefresh();
    }, 300);
  }

  /** Refreshes everything immediately. */
  async refresh(): Promise<void> {
    this.pendingStatus = true;
    this.pendingRefs = true;
    await this.runRefresh();
  }

  private async runRefresh(): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      if (!this.pendingStatus && !this.pendingRefs) return;
    }
    const status = this.pendingStatus;
    const refs = this.pendingRefs;
    this.pendingStatus = this.pendingRefs = false;
    if (!status && !refs) return;
    this.refreshing = (async () => {
      try {
        const tasks: Promise<unknown>[] = [this.loadInfo()];
        if (status) tasks.push(this.loadStatus());
        if (refs) tasks.push(this.loadRefs(), this.loadRemotes(), this.loadStashes());
        await Promise.all(tasks);
      } catch (e) {
        console.error(e);
      }
    })();
    await this.refreshing;
    this.refreshing = undefined;
    this.changeEmitter.fire({ status, refs });
  }

  private async loadInfo() {
    const info: RepoInfo = { ...this.info, operation: this.detectOperation() };
    const head = await this.exec(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true, quiet: true });
    info.branch = head.exitCode === 0 ? head.stdout.trim() : undefined;
    info.detached = head.exitCode !== 0;
    const hash = await this.exec(['rev-parse', '-q', '--verify', 'HEAD'], { allowFailure: true, quiet: true });
    info.headHash = hash.exitCode === 0 ? hash.stdout.trim() : undefined;
    info.empty = !info.headHash;
    info.shallow = fs.existsSync(path.join(this.commonDir, 'shallow'));
    info.upstream = undefined;
    info.ahead = info.behind = 0;
    if (info.branch) {
      const up = await this.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true, quiet: true });
      if (up.exitCode === 0) {
        info.upstream = up.stdout.trim();
        const counts = await this.exec(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], { allowFailure: true, quiet: true });
        const m = /^(\d+)\s+(\d+)/.exec(counts.stdout);
        if (m) {
          info.ahead = +m[1];
          info.behind = +m[2];
        }
      }
    }
    if (info.operation === 'rebase') {
      for (const dir of ['rebase-merge', 'rebase-apply']) {
        const f = path.join(this.gitDir, dir, 'head-name');
        if (fs.existsSync(f)) info.rebaseHeadName = fs.readFileSync(f, 'utf8').trim().replace(/^refs\/heads\//, '');
      }
    } else {
      info.rebaseHeadName = undefined;
    }
    this.info = info;
  }

  detectOperation(): OngoingOperation {
    const has = (f: string) => fs.existsSync(path.join(this.gitDir, f));
    if (has('rebase-merge') || has('rebase-apply/rebasing')) return 'rebase';
    if (has('rebase-apply/applying')) return 'am';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('BISECT_LOG')) return 'bisect';
    return 'none';
  }

  private async loadStatus() {
    const untracked = vscode.workspace.getConfiguration('rebased').get<string>('untrackedFiles', 'all');
    const args = ['status', '--porcelain=v2', '-z', `--untracked-files=${untracked === 'hide' ? 'no' : untracked}`];
    if (vscode.workspace.getConfiguration('rebased').get<boolean>('showIgnoredFiles', false)) args.push('--ignored=matching');
    const out = await this.execText(args, { quiet: true });
    this.status = parseStatusV2(this.root, out);
  }

  private async loadRefs() {
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(HEAD)', '%(creatordate:unix)'].join('%00');
    const out = await this.execText(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true });
    const refs: Ref[] = [];
    const favorites = new Set(this.getFavoriteBranches());
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [fullName, objectName, peeled, upstream, track, cdate, headMark, creatorDate] = line.split('\0');
      if (fullName.endsWith('/HEAD') && fullName.startsWith('refs/remotes/')) continue;
      const hash = peeled || objectName;
      if (fullName.startsWith('refs/heads/')) {
        const name = fullName.slice('refs/heads/'.length);
        const ahead = /ahead (\d+)/.exec(track)?.[1];
        const behind = /behind (\d+)/.exec(track)?.[1];
        refs.push({
          fullName,
          name,
          type: 'local',
          hash,
          upstream: upstream || undefined,
          upstreamGone: track === 'gone',
          ahead: ahead ? +ahead : 0,
          behind: behind ? +behind : 0,
          current: headMark === '*',
          date: +cdate || +creatorDate,
          favorite: favorites.has(fullName),
        });
      } else if (fullName.startsWith('refs/remotes/')) {
        const name = fullName.slice('refs/remotes/'.length);
        refs.push({ fullName, name, type: 'remote', hash, remote: name.split('/')[0], date: +cdate || +creatorDate, favorite: favorites.has(fullName) });
      } else {
        refs.push({ fullName, name: fullName.slice('refs/tags/'.length), type: 'tag', hash, date: +creatorDate || +cdate });
      }
    }
    this.refs = refs;
  }

  private async loadRemotes() {
    const out = await this.execText(['remote', '-v'], { quiet: true });
    const map = new Map<string, Remote>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line);
      if (!m) continue;
      const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
      if (m[3] === 'fetch') r.fetchUrl = m[2];
      else r.pushUrl = m[2];
      map.set(m[1], r);
    }
    this.remotes = [...map.values()];
  }

  private async loadStashes() {
    const out = await this.execText(['stash', 'list', '--format=%gd%x00%H%x00%gs%x00%ct%x01'], { quiet: true, allowFailure: true });
    this.stashes = out
      .split('\x01')
      .map(s => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec, i) => {
        const [ref, hash, gs, ct] = rec.split('\0');
        // "WIP on master: abc123 subject" or "On master: message"
        const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(gs);
        return { index: i, ref, hash, message: m ? m[2] : gs, branch: m?.[1], date: +ct };
      });
  }

  /** Reads a file at a revision. `ref` may be a commit, `:0` (index), `:1`/`:2`/`:3` (merge stages). */
  async show(ref: string, relPath: string): Promise<Buffer> {
    const spec = ref.startsWith(':') ? `${ref}:${relPath}` : `${ref}:${relPath}`;
    const res = await this.exec(['show', spec], { binary: true, allowFailure: true, quiet: true });
    return res.exitCode === 0 ? res.buffer! : Buffer.alloc(0);
  }

  async getConfig(key: string): Promise<string | undefined> {
    const r = await this.exec(['config', '--get', key], { allowFailure: true, quiet: true });
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  }

  get currentBranchRef(): Ref | undefined {
    return this.refs.find(r => r.type === 'local' && r.current);
  }

  absPath(rel: string) {
    return path.join(this.root, rel);
  }

  relPath(abs: string) {
    return path.relative(this.root, abs).replace(/\\/g, '/');
  }

  // Favorite branches are kept in workspace state by the manager, see RepositoryManager.
  getFavoriteBranches: () => string[] = () => [];

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.changeEmitter.dispose();
  }
}

export function parseStatusV2(root: string, out: string): StatusSnapshot {
  const snapshot: StatusSnapshot = { changes: [], unversioned: [], ignored: [], conflicts: [] };
  const entries = splitNul(out);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const kind = e[0];
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = e.split(' ');
      const xy = parts[1];
      const p = parts.slice(8).join(' ');
      snapshot.changes.push({ root, path: p, status: statusFromXY(xy), index: xy[0], workTree: xy[1] });
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const parts = e.split(' ');
      const xy = parts[1];
      const p = parts.slice(9).join(' ');
      const orig = entries[++i];
      const st = statusFromXY(xy);
      snapshot.changes.push({ root, path: p, oldPath: orig, status: st === 'M' ? 'R' : st, index: xy[0], workTree: xy[1] });
    } else if (kind === 'u') {
      const parts = e.split(' ');
      const p = parts.slice(10).join(' ');
      const c: Change = { root, path: p, status: 'U', index: parts[1][0], workTree: parts[1][1] };
      snapshot.conflicts.push(c);
      snapshot.changes.push(c);
    } else if (kind === '?') {
      snapshot.unversioned.push({ root, path: e.slice(2), status: '?' });
    } else if (kind === '!') {
      snapshot.ignored.push({ root, path: e.slice(2), status: '!' });
    }
  }
  return snapshot;
}

function statusFromXY(xy: string): ChangeStatus {
  const [x, y] = xy;
  if (x === 'A' && y !== 'D') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'R') return 'R';
  if (x === 'C') return 'C';
  if (x === 'T' || y === 'T') return 'T';
  return 'M';
}
