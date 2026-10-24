import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { FileState, LhEvent, LocalHistoryStore, normPath } from './store';

const MAX_SIZE = 2 * 1024 * 1024;
const MAX_DIR_FILES = 2000;
const SKIP_SEGMENTS = ['/.git/', '/node_modules/', '/.vscode-test/'];

/**
 * Records local history: saves, creates, deletes and renames done in VS Code, and external changes
 * (git operations, other tools) seen by a file watcher. Like IntelliJ, it keeps a few days of history.
 */
export class LocalHistoryRecorder implements vscode.Disposable {
  readonly store: LocalHistoryStore;
  private readonly disposables: vscode.Disposable[] = [];
  /** Disk content before a save, captured in onWillSave. */
  private readonly beforeSave = new Map<string, FileState>();
  /** Paths handled by a VS Code event recently; the watcher skips them. */
  private readonly recent = new Map<string, number>();
  private readonly pendingDeletes = new Map<string, FileState>();
  private queue = new Map<string, 'change' | 'create' | 'delete'>();
  private timer: NodeJS.Timeout | undefined;
  /** HEAD of each repository a few seconds ago, used as the base of files changed externally. */
  private readonly settledHead = new Map<string, string | undefined>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidRecord = this.emitter.event;
  /**
   * Content of locally modified files that have no recorded event yet (changed before VS Code started),
   * with the time it was read. IntelliJ knows them from its file index; this is the equivalent.
   */
  private readonly baseline = new Map<string, { state: FileState; time: number }>();
  private queueStart = 0;
  private baselineTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: Ctx) {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath).sort().join('\n');
    const key = crypto.createHash('sha1').update(folders || 'no-folder').digest('hex').slice(0, 16);
    this.store = new LocalHistoryStore(path.join(ctx.extension.globalStorageUri.fsPath, 'local-history', key));
    try {
      this.store.purge(this.retentionDays);
    } catch {
      // purge is best effort
    }
    this.hook();
  }

  get retentionDays(): number {
    return vscode.workspace.getConfiguration('ideagittool.localHistory').get<number>('retentionDays', 5);
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('ideagittool.localHistory').get<boolean>('enabled', true);
  }

  private hook() {
    const ws = vscode.workspace;
    ws.onWillSaveTextDocument(e => this.enabled && e.document.uri.scheme === 'file' && this.beforeSave.set(normPath(e.document.uri.fsPath), this.readState(e.document.uri.fsPath)), null, this.disposables);
    ws.onDidSaveTextDocument(d => this.enabled && d.uri.scheme === 'file' && this.onSaved(d.uri.fsPath), null, this.disposables);
    ws.onDidCreateFiles(e => this.enabled && this.onCreated(e.files), null, this.disposables);
    ws.onWillDeleteFiles(e => this.enabled && this.onWillDelete(e.files), null, this.disposables);
    ws.onDidDeleteFiles(e => this.enabled && this.onDeleted(e.files), null, this.disposables);
    ws.onDidRenameFiles(e => this.enabled && this.onRenamed(e.files), null, this.disposables);
    for (const folder of ws.workspaceFolders ?? []) {
      const w = ws.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      w.onDidChange(u => this.enqueue(u, 'change'), null, this.disposables);
      w.onDidCreate(u => this.enqueue(u, 'create'), null, this.disposables);
      w.onDidDelete(u => this.enqueue(u, 'delete'), null, this.disposables);
      this.disposables.push(w);
    }
    const settle = (repo: Repository) => setTimeout(() => this.settledHead.set(repo.root, repo.info.headHash), 3000);
    this.ctx.repos.repositories.forEach(r => this.settledHead.set(r.root, r.info.headHash));
    this.ctx.repos.onDidChangeRepositories(() => this.ctx.repos.repositories.forEach(r => this.settledHead.has(r.root) || this.settledHead.set(r.root, r.info.headHash)), null, this.disposables);
    this.ctx.repos.onDidChangeRepository(e => e.refs && settle(e.repo), null, this.disposables);
    const scheduleBaseline = () => {
      if (this.baselineTimer) clearTimeout(this.baselineTimer);
      this.baselineTimer = setTimeout(() => this.takeBaseline(), 1000);
    };
    this.ctx.repos.onDidChangeRepository(e => e.status && scheduleBaseline(), null, this.disposables);
    this.ctx.repos.onDidChangeRepositories(scheduleBaseline, null, this.disposables);
  }

  /** Reads modified and unversioned files that local history has not seen yet. */
  private takeBaseline() {
    if (!this.enabled || this.queue.size) return;
    let budget = 2000;
    for (const repo of this.ctx.repos.repositories) {
      for (const c of [...repo.status.changes, ...repo.status.unversioned]) {
        if (budget-- <= 0) return;
        if (c.status === 'D') continue;
        const p = normPath(path.join(repo.root, c.path));
        if (this.store.hasSeen(p) || this.baseline.has(p) || this.skip(p)) continue;
        const state = this.readState(p);
        if (state) this.baseline.set(p, { state, time: Date.now() });
      }
    }
  }

  private skip(p: string): boolean {
    const n = normPath(p) + '/';
    if (SKIP_SEGMENTS.some(s => n.includes(s))) return true;
    const storage = normPath(this.ctx.extension.globalStorageUri.fsPath);
    return n.startsWith(storage + '/');
  }

  /** Reads a file into the store: hash, null when missing, undefined when too big or a directory. */
  readState(p: string): FileState {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_SIZE) return undefined;
      return this.store.putContent(fs.readFileSync(p));
    } catch {
      return null;
    }
  }

  private markRecent(p: string) {
    this.recent.set(normPath(p), Date.now());
  }

  private isRecent(p: string) {
    const t = this.recent.get(p);
    return t !== undefined && Date.now() - t < 2500;
  }

  private fire(...events: (LhEvent | undefined)[]) {
    if (events.some(Boolean)) this.emitter.fire();
  }

  private onSaved(file: string) {
    if (this.skip(file)) return;
    const p = normPath(file);
    const after = this.readState(file);
    let before = this.beforeSave.has(p) ? this.beforeSave.get(p) : this.store.latestState(p);
    this.beforeSave.delete(p);
    if (before === undefined) before = this.store.latestState(p);
    this.markRecent(p);
    if (after === undefined || before === after) return;
    this.fire(this.store.record({ kind: before === null ? 'create' : 'change', path: p, before, after }));
  }

  private onCreated(uris: readonly vscode.Uri[]) {
    const group = this.store.newGroup();
    const out: LhEvent[] = [];
    for (const u of uris) {
      for (const f of this.filesUnder(u.fsPath)) {
        if (this.skip(f)) continue;
        this.markRecent(f);
        const after = this.readState(f);
        if (after) out.push(this.store.record({ kind: 'create', path: normPath(f), before: null, after, group }));
      }
    }
    this.fire(...out);
  }

  private onWillDelete(uris: readonly vscode.Uri[]) {
    for (const u of uris) {
      for (const f of this.filesUnder(u.fsPath)) {
        if (this.skip(f)) continue;
        this.pendingDeletes.set(normPath(f), this.readState(f));
      }
    }
  }

  private onDeleted(uris: readonly vscode.Uri[]) {
    const group = this.store.newGroup();
    const out: LhEvent[] = [];
    for (const u of uris) {
      const root = normPath(u.fsPath);
      for (const [p, before] of [...this.pendingDeletes]) {
        if (p !== root && !p.startsWith(root + '/')) continue;
        this.pendingDeletes.delete(p);
        this.markRecent(p);
        if (before) out.push(this.store.record({ kind: 'delete', path: p, before, after: null, group }));
      }
    }
    this.fire(...out);
  }

  private onRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]) {
    const group = this.store.newGroup();
    const out: LhEvent[] = [];
    for (const { oldUri, newUri } of files) {
      const oldRoot = normPath(oldUri.fsPath);
      const newRoot = normPath(newUri.fsPath);
      for (const f of this.filesUnder(newUri.fsPath)) {
        const p = normPath(f);
        const oldPath = oldRoot + p.slice(newRoot.length);
        if (this.skip(f)) continue;
        this.markRecent(p);
        this.markRecent(oldPath);
        const content = this.readState(f);
        out.push(this.store.record({ kind: 'rename', oldPath, path: p, before: content, after: content, group }));
      }
    }
    this.fire(...out);
  }

  private filesUnder(p: string): string[] {
    const out: string[] = [];
    const walk = (x: string) => {
      if (out.length >= MAX_DIR_FILES) return;
      let st: fs.Stats;
      try {
        st = fs.statSync(x);
      } catch {
        // Already gone (delete): the path itself is the file.
        out.push(x);
        return;
      }
      if (st.isFile()) out.push(x);
      else if (st.isDirectory() && !this.skip(x + '/')) {
        for (const e of fs.readdirSync(x)) walk(path.join(x, e));
      }
    };
    walk(p);
    return out;
  }

  // ------------------------------------------------------------------ external changes

  private enqueue(u: vscode.Uri, kind: 'change' | 'create' | 'delete') {
    if (!this.enabled || u.scheme !== 'file' || this.skip(u.fsPath)) return;
    const p = normPath(u.fsPath);
    if (!this.queue.size) this.queueStart = Date.now();
    const prev = this.queue.get(p);
    // create + change = create; create + delete = nothing interesting, keep the last one.
    this.queue.set(p, prev === 'create' && kind === 'change' ? 'create' : kind);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  private async flush() {
    this.timer = undefined;
    const batchStart = this.queueStart;
    // The watcher may report only a directory when a whole directory is created or deleted: expand it
    // to the files below it (on disk for creations, known to local history for deletions).
    const expanded = new Map<string, 'change' | 'create' | 'delete'>();
    for (const [p, kind] of this.queue) {
      let isDir = false;
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {
        // gone
      }
      if (isDir) {
        for (const f of this.filesUnder(p)) if (!this.skip(f)) expanded.set(normPath(f), 'create');
      } else if (kind === 'delete' && !this.store.hasSeen(p) && !this.baseline.has(p)) {
        const prefix = p + '/';
        const known = [...this.baseline.keys(), ...this.store.events.flatMap(LocalHistoryStore.paths)].filter(x => x.startsWith(prefix));
        if (known.length) known.forEach(x => expanded.set(x, 'delete'));
        else expanded.set(p, kind);
      } else expanded.set(p, kind);
    }
    const batch = [...expanded].filter(([p]) => !this.isRecent(p));
    this.queue.clear();
    if (!batch.length) return;
    const ignored = await this.ignoredPaths(batch.map(([p]) => p));
    const group = this.store.newGroup();
    const out: LhEvent[] = [];
    for (const [p, kind] of batch) {
      if (ignored.has(p)) continue;
      const exists = fs.existsSync(p);
      if (exists && fs.statSync(p).isDirectory()) continue;
      const after = exists ? this.readState(p) : null;
      if (after === undefined) continue;
      let before = this.store.latestState(p);
      // A baseline read before the change started is the best "before"; one read later may already
      // contain the change, then the git version is used.
      const base = this.baseline.get(p);
      if (before === undefined && base && base.time < batchStart) before = base.state;
      if (before === undefined) before = await this.gitBase(p);
      this.baseline.delete(p);
      if (before === after) continue;
      if (before === undefined && after === null) continue;
      const k = after === null ? 'delete' : before === null || (before === undefined && kind === 'create') ? 'create' : 'change';
      out.push(this.store.record({ kind: k, path: p, before, after, external: true, group }));
    }
    this.fire(...out);
  }

  /** Content of a file at the settled HEAD of its repository (base for files changed outside VS Code). */
  private async gitBase(p: string): Promise<FileState> {
    const repo = this.ctx.repos.getForFile(p);
    if (!repo) return undefined;
    const head = this.settledHead.get(repo.root) ?? repo.info.headHash;
    if (!head) return null;
    const rel = repo.relPath(p);
    const r = await repo.exec(['cat-file', 'blob', `${head}:${rel}`], { binary: true, allowFailure: true, quiet: true });
    if (r.exitCode !== 0) return null;
    if (r.buffer!.length > MAX_SIZE) return undefined;
    return this.store.putContent(r.buffer!);
  }

  private async ignoredPaths(paths: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const byRepo = new Map<Repository, string[]>();
    for (const p of paths) {
      const r = this.ctx.repos.getForFile(p);
      if (r) byRepo.set(r, [...(byRepo.get(r) ?? []), p]);
    }
    for (const [repo, list] of byRepo) {
      const rels = list.map(p => repo.relPath(p));
      const r = await repo.exec(['check-ignore', '--stdin', '-z'], { input: rels.join('\0') + '\0', allowFailure: true, quiet: true });
      for (const rel of r.stdout.split('\0').filter(Boolean)) out.add(normPath(path.join(repo.root, rel)));
    }
    return out;
  }

  // ------------------------------------------------------------------ labels

  putLabel(label: string, system = false): LhEvent {
    const e = this.store.record({ kind: system ? 'system' : 'label', label });
    this.emitter.fire();
    return e;
  }

  /** Writes the given states to disk (Revert), recording the result as one change group. */
  async apply(states: { path: string; state: FileState }[], label: string) {
    this.putLabel(label, true);
    const group = this.store.newGroup();
    for (const { path: p, state } of states) {
      if (state === undefined) continue;
      const before = this.readState(p);
      this.markRecent(p);
      if (state === null) {
        fs.rmSync(p, { force: true });
      } else {
        const data = this.store.getContent(state);
        if (!data) throw new Error(vscode.l10n.t('Content of {0} is not available', p));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
      }
      if (before !== state) this.store.record({ kind: state === null ? 'delete' : before === null ? 'create' : 'change', path: p, before, after: state, group });
    }
    this.emitter.fire();
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
