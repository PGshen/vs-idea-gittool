import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One recorded event. Paths are absolute with forward slashes. Content is referenced by hash;
 * `null` means "the file did not exist", `undefined` means "unknown".
 */
export interface LhEvent {
  id: number;
  /** Unix milliseconds. */
  ts: number;
  kind: 'change' | 'create' | 'delete' | 'rename' | 'label' | 'system';
  path?: string;
  /** For renames: the old path. */
  oldPath?: string;
  before?: string | null;
  after?: string | null;
  /** Label name for 'label' (Put Label…) and 'system' (Before Update, …) events. */
  label?: string;
  /** Changed outside of VS Code (git operations, other tools). */
  external?: boolean;
  /** Events recorded together (one save-all, one git operation) share a group. */
  group: number;
}

/** State of a file at some point: content hash, null (did not exist) or undefined (same as now / unknown). */
export type FileState = string | null | undefined;

export function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * IntelliJ-like local history storage: an append-only event log (`events.jsonl`) plus a
 * content-addressed blob store (`content/ab/cdef…`).
 */
export class LocalHistoryStore {
  events: LhEvent[] = [];
  private nextId = 1;
  private nextGroup = 1;
  private readonly eventsFile: string;
  private readonly contentDir: string;
  /** Latest known content per path, from the newest event. */
  private readonly latest = new Map<string, FileState>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.contentDir = path.join(dir, 'content');
    fs.mkdirSync(this.contentDir, { recursive: true });
    this.load();
  }

  private load() {
    let text = '';
    try {
      text = fs.readFileSync(this.eventsFile, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.add(JSON.parse(line) as LhEvent);
      } catch {
        // A torn write at the end of the file: ignore the line.
      }
    }
  }

  private add(e: LhEvent) {
    this.events.push(e);
    this.nextId = Math.max(this.nextId, e.id + 1);
    this.nextGroup = Math.max(this.nextGroup, e.group + 1);
    if (e.kind === 'rename') {
      if (e.oldPath) this.latest.set(e.oldPath, null);
      if (e.path) this.latest.set(e.path, e.after);
    } else if (e.path && e.kind !== 'label' && e.kind !== 'system') {
      this.latest.set(e.path, e.after);
    }
  }

  newGroup(): number {
    return this.nextGroup++;
  }

  putContent(data: Buffer | Uint8Array | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    const file = this.contentPath(hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return hash;
  }

  getContent(hash: string): Buffer | undefined {
    try {
      return fs.readFileSync(this.contentPath(hash));
    } catch {
      return undefined;
    }
  }

  private contentPath(hash: string) {
    return path.join(this.contentDir, hash.slice(0, 2), hash.slice(2));
  }

  /** Last recorded state of a path (undefined when never seen). */
  latestState(p: string): FileState {
    return this.latest.get(p);
  }

  hasSeen(p: string): boolean {
    return this.latest.has(p);
  }

  record(e: Omit<LhEvent, 'id' | 'ts' | 'group'> & { ts?: number; group?: number }): LhEvent {
    const ev: LhEvent = { ...e, id: this.nextId, ts: e.ts ?? Date.now(), group: e.group ?? this.newGroup() };
    for (const k of Object.keys(ev) as (keyof LhEvent)[]) if (ev[k] === undefined) delete ev[k];
    this.add(ev);
    fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n');
    return ev;
  }

  /** Paths touched by an event. */
  static paths(e: LhEvent): string[] {
    const out: string[] = [];
    if (e.path) out.push(e.path);
    if (e.oldPath) out.push(e.oldPath);
    return out;
  }

  /** Events that touch `p` (a file, or a directory when `dir`), plus labels. Oldest first. */
  eventsFor(p: string | undefined, dir = false): LhEvent[] {
    if (p === undefined) return this.events;
    const prefix = p.endsWith('/') ? p : p + '/';
    const match = (x: string) => (dir ? x === p || x.startsWith(prefix) : x === p);
    return this.events.filter(e => e.kind === 'label' || e.kind === 'system' || LocalHistoryStore.paths(e).some(match));
  }

  /** State of `p` just before event `id` (state after all events with smaller ids). */
  stateBefore(p: string, id: number): FileState {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.id >= id) continue;
      if (e.kind === 'rename') {
        if (e.oldPath === p) return null;
        if (e.path === p) return e.after;
      } else if (e.path === p && e.kind !== 'label' && e.kind !== 'system') {
        return e.after;
      }
    }
    // Nothing earlier: use what the first later event saw as "before".
    for (const e of this.events) {
      if (e.id < id) continue;
      if (e.kind === 'rename') {
        if (e.path === p) return null;
        if (e.oldPath === p) return e.before;
      } else if (e.path === p && e.kind !== 'label' && e.kind !== 'system') {
        return e.before;
      }
    }
    return undefined;
  }

  /** State of `p` right after event `id`. */
  stateAfter(p: string, id: number): FileState {
    return this.stateBefore(p, id + 1);
  }

  /** Paths changed by events with id >= `id`, limited to `scope` (file / directory prefix / all). */
  pathsChangedSince(id: number, scope?: { path: string; dir: boolean }): string[] {
    const set = new Set<string>();
    const prefix = scope ? (scope.path.endsWith('/') ? scope.path : scope.path + '/') : '';
    for (const e of this.events) {
      if (e.id < id) continue;
      for (const p of LocalHistoryStore.paths(e)) {
        if (!scope || p === scope.path || (scope.dir && p.startsWith(prefix))) set.add(p);
      }
    }
    return [...set].sort();
  }

  /** Removes events older than `days` and content no longer referenced. */
  purge(days: number, now = Date.now()) {
    const limit = now - days * 86400_000;
    const keep = this.events.filter(e => e.ts >= limit);
    if (keep.length === this.events.length) return;
    this.events = [];
    this.latest.clear();
    keep.forEach(e => this.add(e));
    fs.writeFileSync(this.eventsFile, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    const used = new Set<string>();
    for (const e of keep) {
      if (e.before) used.add(e.before);
      if (e.after) used.add(e.after);
    }
    for (const d of fs.readdirSync(this.contentDir)) {
      const sub = path.join(this.contentDir, d);
      for (const f of fs.readdirSync(sub)) if (!used.has(d + f)) fs.rmSync(path.join(sub, f), { force: true });
    }
  }
}
