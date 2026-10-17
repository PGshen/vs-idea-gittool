import { GraphLayout, Segment } from '../../git/graph';
import { LogStream } from '../../git/logStream';
import { Repository } from '../../git/repository';
import { Commit, GraphRow } from '../../shared/types';
import { filtersForRepo, HASH_RE, isStructureBroken, LogFilters, logArgs, LogOptions } from './filters';

export interface LogRow {
  commit: Commit;
  graph: GraphRow;
  /** Reachable from HEAD of its repository (current branch highlight). */
  inHead: boolean;
}

const PAGE = 500;

interface CommitSource {
  next(n: number): Promise<{ commits: Commit[]; done: boolean }>;
  dispose(): void;
}

/**
 * Merges the logs of several repositories by commit date, like IntelliJ's multi-root log.
 */
export class MergedStream implements CommitSource {
  private readonly buffers: Commit[][];
  private readonly finished: boolean[];

  constructor(private readonly streams: CommitSource[]) {
    this.buffers = streams.map(() => []);
    this.finished = streams.map(() => false);
  }

  private async fill(i: number) {
    if (this.finished[i] || this.buffers[i].length) return;
    const r = await this.streams[i].next(200);
    this.buffers[i].push(...r.commits);
    if (r.done) this.finished[i] = true;
  }

  async next(n: number): Promise<{ commits: Commit[]; done: boolean }> {
    const out: Commit[] = [];
    while (out.length < n) {
      await Promise.all(this.streams.map((_, i) => this.fill(i)));
      let best = -1;
      for (let i = 0; i < this.buffers.length; i++) {
        const c = this.buffers[i][0];
        if (c && (best < 0 || c.commitDate > this.buffers[best][0].commitDate)) best = i;
      }
      if (best < 0) break;
      out.push(this.buffers[best].shift()!);
    }
    const done = this.buffers.every((b, i) => !b.length && this.finished[i]);
    return { commits: out, done };
  }

  dispose() {
    this.streams.forEach(s => s.dispose());
  }
}

/**
 * Loaded part of the log for one tab: commits in display order plus their graph rows.
 * Loads lazily from LogStreams as the table scrolls. With several repositories the logs are merged.
 */
export class LogModel {
  rows: LogRow[] = [];
  done = false;
  error: string | undefined;
  private stream: CommitSource | undefined;
  private layout = new GraphLayout();
  /** Row index per hash; -2 for commits hidden by Collapse Linear Branches. */
  private index = new Map<string, number>();
  private loading: Promise<void> | undefined;
  private generationValue = 0;
  /** Linear graph (file history with --follow), or no edges (text/user/date filters). */
  private graphMode: 'full' | 'linear' | 'none' = 'full';
  private pendingLinear: Commit | undefined;
  private headReach = new Set<string>();
  private heads = new Set<string>();
  private collapseLinear = false;
  private childCount = new Map<string, number>();
  private onlyChild = new Map<string, string>();
  private linear = new Set<string>();
  hiddenCount = 0;

  constructor(private repos: Repository[]) {}

  /** Bumped by every reset; rows sent to the webview carry it so stale rows are dropped. */
  get generation() {
    return this.generationValue;
  }

  get segments(): Segment[] {
    return this.layout.segments;
  }

  get repositories() {
    return this.repos;
  }

  setRepositories(repos: Repository[]) {
    this.repos = repos;
  }

  /** Restarts loading with new filters. Resolves after the first page is loaded. */
  async reset(filters: LogFilters, options: LogOptions, me?: string[]): Promise<void> {
    this.stream?.dispose();
    this.generationValue++;
    this.rows = [];
    this.index.clear();
    this.done = false;
    this.error = undefined;
    this.layout = new GraphLayout();
    this.pendingLinear = undefined;
    this.childCount = new Map();
    this.onlyChild = new Map();
    this.linear = new Set();
    this.hiddenCount = 0;
    this.headReach = new Set(this.repos.map(r => r.info.headHash).filter((h): h is string => !!h));
    this.heads = new Set(this.headReach);
    this.graphMode = filters.follow || filters.lines ? 'linear' : isStructureBroken(filters) ? 'none' : 'full';
    this.collapseLinear = !!options.collapseLinear && this.graphMode === 'full';
    const resolved: LogFilters = { ...filters, users: filters.users.flatMap(u => (u === 'me' ? (me ?? []) : [u])) };
    const primary = this.repos[0]?.root ?? '';
    const sources: CommitSource[] = [];
    let hashHit: Commit | undefined;
    for (const repo of this.repos) {
      if (repo.info.empty) continue;
      const f = this.repos.length > 1 ? filtersForRepo(resolved, repo, primary) : resolved;
      if (!f) continue;
      // A hash in the text filter shows that commit (IntelliJ: "Text or hash").
      if (!hashHit && f.text && HASH_RE.test(f.text.trim())) {
        const r = await repo.exec(['rev-parse', '-q', '--verify', `${f.text.trim()}^{commit}`], { allowFailure: true, quiet: true });
        if (r.exitCode === 0) {
          const s = new LogStream(repo.root, ['-1', r.stdout.trim(), '--']);
          hashHit = (await s.next(1)).commits[0];
          s.dispose();
        }
      }
      sources.push(new LogStream(repo.root, logArgs(f, options)));
    }
    if (!sources.length) {
      this.done = true;
      if (hashHit) this.append([hashHit]);
      return;
    }
    this.stream = sources.length === 1 ? sources[0] : new MergedStream(sources);
    this.loading = undefined;
    if (hashHit) this.append([hashHit]);
    await this.ensure(PAGE);
  }

  /** Makes sure at least `count` rows are loaded (or the log ended). */
  async ensure(count: number): Promise<void> {
    while (this.rows.length < count && !this.done) {
      if (!this.loading) {
        const gen = this.generationValue;
        this.loading = (async () => {
          try {
            const { commits, done } = await this.stream!.next(Math.max(PAGE, count - this.rows.length));
            if (gen !== this.generationValue) return;
            this.append(commits);
            if (done) {
              this.done = true;
              this.flushLinear();
            }
          } catch (e) {
            if (gen !== this.generationValue) return;
            this.error = e instanceof Error ? e.message : String(e);
            this.done = true;
          } finally {
            if (gen === this.generationValue) this.loading = undefined;
          }
        })();
      }
      const gen = this.generationValue;
      await this.loading;
      if (gen !== this.generationValue) return;
    }
  }

  private append(commits: Commit[]) {
    for (let k = 0; k < commits.length; k++) {
      const c = commits[k];
      if (this.index.has(c.hash)) continue;
      if (this.graphMode === 'linear') {
        // Each commit links to the next one in the list: layout is done one commit late.
        if (this.pendingLinear) this.push(this.pendingLinear, [c.hash]);
        this.pendingLinear = c;
        this.index.set(c.hash, -1);
        continue;
      }
      if (this.collapseLinear && this.shouldHide(c, commits, k)) {
        this.hide(c);
        continue;
      }
      this.push(c, this.graphMode === 'none' ? [] : c.parents);
    }
  }

  private isLinear(c: Commit, children: number) {
    return c.parents.length === 1 && children === 1 && c.refs.length === 0 && !this.heads.has(c.hash);
  }

  /**
   * Collapse Linear Branches: a commit is hidden when it, its only child and its parent all lie on a
   * linear fragment (one parent, one child, no references). The first and the last commit of the
   * fragment stay visible and are joined by a dotted edge. Children always come before parents in
   * the log, so the number of children is known; the parent is looked up in the current page.
   */
  private shouldHide(c: Commit, page: Commit[], k: number): boolean {
    const children = this.childCount.get(c.hash) ?? 0;
    const linear = this.isLinear(c, children);
    if (linear) this.linear.add(c.hash);
    if (!linear) return false;
    const child = this.onlyChild.get(c.hash);
    if (!child || !this.linear.has(child)) return false;
    const p = c.parents[0];
    let parentChildren = (this.childCount.get(p) ?? 0) + 1;
    for (let m = k + 1; m < page.length; m++) {
      const x = page[m];
      if (x.hash === p) return this.isLinear(x, parentChildren);
      if (x.parents.includes(p)) parentChildren++;
    }
    return false;
  }

  private countChildren(c: Commit) {
    for (const p of c.parents) {
      this.childCount.set(p, (this.childCount.get(p) ?? 0) + 1);
      this.onlyChild.set(p, c.hash);
    }
    if (this.headReach.has(c.hash)) for (const p of c.parents) this.headReach.add(p);
  }

  private hide(c: Commit) {
    this.index.set(c.hash, -2);
    this.hiddenCount++;
    this.countChildren(c);
    this.layout.collapse(c.hash, c.parents[0]);
  }

  private flushLinear() {
    if (this.pendingLinear) {
      this.push(this.pendingLinear, []);
      this.pendingLinear = undefined;
    }
  }

  private push(c: Commit, parents: string[]) {
    this.index.set(c.hash, this.rows.length);
    const inHead = this.headReach.has(c.hash);
    if (this.collapseLinear && !this.linear.has(c.hash) && this.isLinear(c, this.childCount.get(c.hash) ?? 0)) this.linear.add(c.hash);
    this.countChildren(c);
    this.rows.push({ commit: c, graph: this.layout.add(c.hash, parents), inHead });
  }

  indexOf(hash: string): number {
    const i = this.index.get(hash);
    return i === undefined || i < 0 ? -1 : i;
  }

  /** True when the commit was loaded but hidden by Collapse Linear Branches. */
  isHidden(hash: string): boolean {
    for (const [h, i] of this.index) if (i === -2 && (h === hash || (hash.length < 40 && h.startsWith(hash)))) return true;
    return false;
  }

  /** Repository of a loaded commit. */
  rootOf(hash: string): string | undefined {
    return this.rows[this.indexOf(hash)]?.commit.root;
  }

  /** Finds a commit by full or abbreviated hash among loaded rows, loading more pages if needed. */
  async find(hash: string, maxRows = 50000): Promise<number> {
    const match = () => {
      const exact = this.indexOf(hash);
      if (exact >= 0) return exact;
      if (hash.length < 40) return this.rows.findIndex(r => r.commit.hash.startsWith(hash));
      return -1;
    };
    let i = match();
    while (i < 0 && !this.done && this.rows.length < maxRows) {
      await this.ensure(this.rows.length + PAGE * 4);
      i = match();
    }
    return i;
  }

  dispose() {
    this.generationValue++;
    this.stream?.dispose();
  }
}
