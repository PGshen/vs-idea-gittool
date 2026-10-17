import { GraphLayout } from '../../git/graph';
import { LogStream } from '../../git/logStream';
import { Repository } from '../../git/repository';
import { Commit, GraphRow } from '../../shared/types';
import { HASH_RE, isStructureBroken, LogFilters, logArgs, LogOptions } from './filters';

export interface LogRow {
  commit: Commit;
  graph: GraphRow;
  /** Reachable from HEAD (current branch highlight). */
  inHead: boolean;
}

const PAGE = 500;

/**
 * Loaded part of the log for one tab: commits in display order plus their graph rows.
 * Loads lazily from a LogStream as the table scrolls.
 */
export class LogModel {
  rows: LogRow[] = [];
  done = false;
  error: string | undefined;
  private stream: LogStream | undefined;
  private layout = new GraphLayout();
  private index = new Map<string, number>();
  private loading: Promise<void> | undefined;
  private generation = 0;
  /** Linear graph (file history with --follow), or no edges (text/user/date filters). */
  private graphMode: 'full' | 'linear' | 'none' = 'full';
  private pendingLinear: Commit | undefined;
  private headReach = new Set<string>();

  constructor(private readonly repo: Repository) {}

  /** Restarts loading with new filters. Resolves after the first page is loaded. */
  async reset(filters: LogFilters, options: LogOptions, me?: string[]): Promise<void> {
    this.stream?.dispose();
    this.generation++;
    this.rows = [];
    this.index.clear();
    this.done = false;
    this.error = undefined;
    this.layout = new GraphLayout();
    this.pendingLinear = undefined;
    this.headReach = new Set(this.repo.info.headHash ? [this.repo.info.headHash] : []);
    this.graphMode = filters.follow || filters.lines ? 'linear' : isStructureBroken(filters) ? 'none' : 'full';
    const resolved: LogFilters = { ...filters, users: filters.users.flatMap(u => (u === 'me' ? (me ?? []) : [u])) };
    if (this.repo.info.empty) {
      this.done = true;
      return;
    }
    // A hash in the text filter shows that commit (IntelliJ: "Text or hash").
    let hashHit: Commit | undefined;
    if (filters.text && HASH_RE.test(filters.text.trim())) {
      const r = await this.repo.exec(['rev-parse', '-q', '--verify', `${filters.text.trim()}^{commit}`], { allowFailure: true, quiet: true });
      if (r.exitCode === 0) {
        const s = new LogStream(this.repo.root, ['-1', r.stdout.trim(), '--']);
        hashHit = (await s.next(1)).commits[0];
        s.dispose();
      }
    }
    this.stream = new LogStream(this.repo.root, logArgs(resolved, options));
    this.loading = undefined;
    if (hashHit) this.append([hashHit]);
    await this.ensure(PAGE);
  }

  /** Makes sure at least `count` rows are loaded (or the log ended). */
  async ensure(count: number): Promise<void> {
    while (this.rows.length < count && !this.done) {
      if (!this.loading) {
        const gen = this.generation;
        this.loading = (async () => {
          try {
            const { commits, done } = await this.stream!.next(Math.max(PAGE, count - this.rows.length));
            if (gen !== this.generation) return;
            this.append(commits);
            if (done) {
              this.done = true;
              this.flushLinear();
            }
          } catch (e) {
            if (gen !== this.generation) return;
            this.error = e instanceof Error ? e.message : String(e);
            this.done = true;
          } finally {
            if (gen === this.generation) this.loading = undefined;
          }
        })();
      }
      const gen = this.generation;
      await this.loading;
      if (gen !== this.generation) return;
    }
  }

  private append(commits: Commit[]) {
    for (const c of commits) {
      if (this.index.has(c.hash)) continue;
      if (this.graphMode === 'linear') {
        // Each commit links to the next one in the list: layout is done one commit late.
        if (this.pendingLinear) this.push(this.pendingLinear, [c.hash]);
        this.pendingLinear = c;
        this.index.set(c.hash, -1);
        continue;
      }
      this.push(c, this.graphMode === 'none' ? [] : c.parents);
    }
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
    if (inHead) for (const p of c.parents) this.headReach.add(p);
    this.rows.push({ commit: c, graph: this.layout.add(c.hash, parents), inHead });
  }

  indexOf(hash: string): number {
    const i = this.index.get(hash);
    return i === undefined ? -1 : i;
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
    this.generation++;
    this.stream?.dispose();
  }
}
