import { useEffect, useState } from 'preact/hooks';
import type { DetailsResult, LogFiltersDto, LogInit, LogOptionsDto, LogUiSettings, RowData, RowsResult } from '../../shared/logProtocol';
import type { Ref } from '../../shared/types';
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
  title = this.init.title;
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
    on('refresh', async (d: { refs: Ref[]; head: LogInit['head']; total: number; done: boolean }) => {
      this.refs = d.refs;
      this.head = d.head;
      const keep = [...this.selection];
      this.resetRows(d.total, d.done);
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

  resetRows(total: number, done: boolean) {
    this.generation++;
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
    const res = await call<{ total: number; done: boolean; title: string }>('setFilters', { filters, options });
    this.title = res.title;
    this.resetRows(res.total, res.done);
    await this.ensureRows(0, CHUNK);
    this.loading = false;
    const keep = [...this.selection];
    this.reselect(keep);
  }

  updateSettings(patch: Partial<LogUiSettings>) {
    this.settings = { ...this.settings, ...patch };
    void call('saveSettings', this.settings);
    this.emit();
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
