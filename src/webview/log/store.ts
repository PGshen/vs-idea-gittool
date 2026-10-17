import { useEffect, useState } from 'preact/hooks';
import type { DetailsResult, LogFiltersDto, LogInit, LogOptionsDto, LogRepo, LogUiSettings, RefreshEvent, RowData, RowsResult, SignatureInfo } from '../../shared/logProtocol';
import type { Change, Ref } from '../../shared/types';
import { boot, call, on } from '../lib/rpc';

const CHUNK = 200;

/** State of the log tab webview. Components subscribe with useStore(). */
class LogStore {
  init: LogInit = boot.initial as LogInit;
  settings: LogUiSettings = this.init.settings;
  filters: LogFiltersDto = this.init.filters;
  options: LogOptionsDto = this.init.options;
  refs: Ref[] = this.init.refs;
  head = this.init.head;
  repos: LogRepo[] = this.init.repos;
  title = this.init.title;
  /** Generation of the host model the cached rows belong to. */
  modelGen: number | undefined;
  /** GPG signature per hash (GPG Signature column). */
  signatures = new Map<string, SignatureInfo>();
  /** Not Cherry-Picked Commits highlighter: compared branch and the commits not picked yet. */
  cherryPick: { branch: string; nonPicked?: Set<string> } | undefined;
  /** Show My Branches: full ref names (prefixed with root and NUL in a multi-root log). */
  myBranches: Set<string> | undefined;
  /** File shown in the diff preview. */
  previewChange: Change | undefined;
  total = 0;
  done = false;
  error: string | undefined;
  loading = true;
  /** Bumped when the row cache is cleared, so stale fetches are dropped. */
  generation = 0;
  rows = new Map<number, RowData>();
  selection = new Set<string>();
  lead = -1;
  anchor = -1;
  details: DetailsResult | null = null;
  detailsLoading = false;
  showChangesToParents = false;
  /** Index to scroll to (consumed by the table). */
  scrollTo: number | undefined;
  private pending = new Set<number>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit() {
    this.version++;
    this.listeners.forEach(l => l());
  }

  get root() {
    return this.init.root;
  }

  async start() {
    on('refresh', async (d: RefreshEvent) => {
      this.refs = d.refs;
      this.head = d.head;
      this.repos = d.repos;
      const keep = [...this.selection];
      this.resetRows(d.total, d.done, d.gen);
      if (this.cherryPick) void this.loadCherryPicked(this.cherryPick.branch);
      if (this.myBranches) void this.loadMyBranches();
      await this.ensureRows(0, CHUNK);
      // Keep the selection on the same commits when they are still loaded.
      this.reselect(keep);
    });
    on('select', (d: { hash: string; index: number; total: number }) => {
      this.total = Math.max(this.total, d.total);
      void this.selectIndex(d.index, { hash: d.hash });
    });
    on('settings', (s: LogUiSettings) => {
      this.settings = s;
      this.emit();
    });
    on('optionsChanged', (d: { options: LogOptionsDto; total: number; done: boolean; gen: number }) => {
      this.options = d.options;
      this.resetRows(d.total, d.done, d.gen);
      this.emit();
    });
    on('filtersReset', (d: { filters: LogFiltersDto }) => {
      this.filters = d.filters;
      this.resetRows(0, false);
      void this.ensureRows(0, CHUNK);
    });
    await this.ensureRows(0, CHUNK);
    this.loading = false;
    if (this.init.select) {
      const r = [...this.rows.values()].find(x => x.h.startsWith(this.init.select!));
      if (r) await this.selectIndex(this.indexOfHash(r.h));
    } else if (this.rows.size && this.selection.size === 0) {
      // IntelliJ selects HEAD (or the first row) when the log opens.
      const headIdx = this.head.hash ? this.indexOfHash(this.head.hash) : -1;
      await this.selectIndex(headIdx >= 0 ? headIdx : 0, { noScroll: headIdx < 0 });
    }
    this.emit();
  }

  private reselect(keep: string[]) {
    const indices = keep.map(h => this.indexOfHash(h)).filter(i => i >= 0);
    this.selection = new Set(indices.map(i => this.rows.get(i)!.h));
    if (indices.length) this.lead = indices[0];
    else if (this.rows.size) {
      this.lead = 0;
      this.selection = new Set([this.rows.get(0)!.h]);
    }
    this.emit();
    void this.loadDetails();
  }

  resetRows(total: number, done: boolean, modelGen?: number) {
    this.generation++;
    this.modelGen = modelGen;
    this.rows = new Map();
    this.pending.clear();
    this.total = total;
    this.done = done;
    this.error = undefined;
  }

  indexOfHash(hash: string): number {
    for (const [i, r] of this.rows) if (r.h === hash) return i;
    return -1;
  }

  /** Loads rows [start, end) that are not cached yet. */
  async ensureRows(start: number, end: number) {
    const gen = this.generation;
    const first = Math.floor(Math.max(0, start) / CHUNK);
    const last = Math.floor(Math.max(0, end - 1) / CHUNK);
    const tasks: Promise<void>[] = [];
    for (let c = first; c <= last; c++) {
      if (this.pending.has(c) || this.rows.has(c * CHUNK)) continue;
      if (this.done && c * CHUNK >= this.total) continue;
      this.pending.add(c);
      tasks.push(
        call<RowsResult>('rows', { start: c * CHUNK, count: CHUNK })
          .then(res => {
            if (gen !== this.generation) return;
            // Rows of another host model generation (a refresh happened meanwhile) must not be mixed in.
            if (this.modelGen === undefined) this.modelGen = res.gen;
            else if (res.gen !== this.modelGen) return;
            res.rows.forEach((r, i) => this.rows.set(res.start + i, r));
            this.total = res.total;
            this.done = res.done;
            this.error = res.error;
          })
          .finally(() => {
            if (gen === this.generation) this.pending.delete(c);
          }),
      );
    }
    if (tasks.length) {
      await Promise.all(tasks);
      if (gen === this.generation) this.emit();
    }
  }

  async setFilters(filters: LogFiltersDto, options: LogOptionsDto = this.options) {
    this.filters = filters;
    this.options = options;
    this.loading = true;
    this.resetRows(0, false);
    this.emit();
    const res = await call<{ total: number; done: boolean; title: string; gen: number }>('setFilters', { filters, options });
    this.title = res.title;
    this.resetRows(res.total, res.done, res.gen);
    if (this.cherryPick && !(filters.branches.length === 1 && filters.branches[0] === this.cherryPick.branch)) this.cherryPick = undefined;
    await this.ensureRows(0, CHUNK);
    this.loading = false;
    const keep = [...this.selection];
    this.reselect(keep);
  }

  updateSettings(patch: Partial<LogUiSettings>) {
    const longEdges = 'showLongEdges' in patch && patch.showLongEdges !== this.settings.showLongEdges;
    this.settings = { ...this.settings, ...patch };
    const saved = call('saveSettings', this.settings);
    if (longEdges) {
      // Graph rows are laid out on the host with the long edge setting: reload them.
      void saved.then(() => {
        this.resetRows(this.total, this.done, this.modelGen);
        void this.ensureRows(Math.max(0, this.lead - CHUNK), this.lead + CHUNK);
      });
    }
    if ('columns' in patch && this.settings.columns.signature) void this.loadSignatures([...this.rows.values()].map(r => r.h));
    this.emit();
  }

  private sigPending = new Set<string>();

  /** Loads GPG signatures of the given commits (GPG Signature column). */
  async loadSignatures(hashes: string[]) {
    const missing = hashes.filter(h => !this.signatures.has(h) && !this.sigPending.has(h));
    if (!missing.length) return;
    missing.forEach(h => this.sigPending.add(h));
    try {
      const res = await call<Record<string, SignatureInfo>>('signatures', missing);
      for (const [h, info] of Object.entries(res)) this.signatures.set(h, info);
    } finally {
      missing.forEach(h => this.sigPending.delete(h));
      this.emit();
    }
  }

  async loadCherryPicked(branch: string) {
    this.cherryPick = { branch };
    this.emit();
    const res = await call<{ nonPicked: string[] }>('cherryPicked', { branch });
    if (this.cherryPick?.branch === branch) {
      this.cherryPick = { branch, nonPicked: new Set(res.nonPicked) };
      this.emit();
    }
  }

  async loadMyBranches() {
    this.myBranches = new Set(await call<string[]>('myBranches'));
    this.emit();
  }

  /** Repository of a row (multi-root log). */
  repoOf(r: RowData): LogRepo | undefined {
    return r.r !== undefined ? this.repos[r.r] : undefined;
  }

  /** Root used for actions on a commit. */
  rootOf(hash: string): string {
    for (const r of this.rows.values()) if (r.h === hash) return this.repoOf(r)?.root ?? this.root;
    return this.root;
  }

  async selectIndex(i: number, opts: { hash?: string; shift?: boolean; toggle?: boolean; noScroll?: boolean } = {}) {
    if (i < 0) return;
    if (!this.rows.has(i)) await this.ensureRows(i - CHUNK / 2, i + CHUNK / 2);
    const row = this.rows.get(i);
    if (!row) return;
    if (opts.shift && this.anchor >= 0) {
      const sel = new Set<string>();
      await this.ensureRows(Math.min(this.anchor, i), Math.max(this.anchor, i) + 1);
      for (let j = Math.min(this.anchor, i); j <= Math.max(this.anchor, i); j++) {
        const r = this.rows.get(j);
        if (r) sel.add(r.h);
      }
      this.selection = sel;
    } else if (opts.toggle) {
      const sel = new Set(this.selection);
      if (sel.has(row.h)) sel.delete(row.h);
      else sel.add(row.h);
      this.selection = sel;
      this.anchor = i;
    } else {
      this.selection = new Set([row.h]);
      this.anchor = i;
    }
    this.lead = i;
    if (!opts.noScroll) this.scrollTo = i;
    this.emit();
    this.scheduleDetails();
  }

  private detailsTimer: number | undefined;
  private detailsGen = 0;

  scheduleDetails() {
    clearTimeout(this.detailsTimer);
    this.detailsTimer = window.setTimeout(() => void this.loadDetails(), 80);
  }

  async loadDetails() {
    const hashes = [...this.selection];
    const gen = ++this.detailsGen;
    if (!hashes.length) {
      this.details = null;
      this.emit();
      return;
    }
    this.detailsLoading = true;
    this.emit();
    try {
      const d = await call<DetailsResult>('details', { hashes, toParents: this.showChangesToParents });
      if (gen !== this.detailsGen) return;
      this.details = d;
    } catch {
      if (gen === this.detailsGen) this.details = null;
    } finally {
      if (gen === this.detailsGen) {
        this.detailsLoading = false;
        this.emit();
      }
    }
  }

  selectedRows(): RowData[] {
    const out: RowData[] = [];
    for (const [, r] of [...this.rows].sort((a, b) => a[0] - b[0])) if (this.selection.has(r.h)) out.push(r);
    return out;
  }

  get currentBranch() {
    return this.head.detached ? undefined : this.head.branch;
  }
}

export const store = new LogStore();

export function useStore() {
  const [, set] = useState(0);
  useEffect(() => store.subscribe(() => set(v => v + 1)), []);
  return store;
}
