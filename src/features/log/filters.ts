// Log filters (VcsLogFilterCollection) and their translation to `git log` arguments.

export interface LogFilters {
  /** Branch / ref filter. Empty = all branches (IntelliJ's "Branch: All"). Items are ref names or revision ranges. */
  branches: string[];
  /** Author patterns; "me" is resolved by the caller. */
  users: string[];
  /** Unix seconds. */
  since?: number;
  until?: number;
  /** Repository-relative paths. */
  paths: string[];
  text: string;
  regex: boolean;
  matchCase: boolean;
  /** For file history: follow renames of a single file. */
  follow?: boolean;
  /** "Show History for Selection": `git log -L start,end:path`. */
  lines?: { path: string; start: number; end: number };
}

export interface LogOptions {
  sort: 'topo' | 'date';
  firstParent: boolean;
  noMerges?: boolean;
}

export const EMPTY_FILTERS: LogFilters = { branches: [], users: [], paths: [], text: '', regex: false, matchCase: false };

export const HASH_RE = /^[0-9a-fA-F]{7,40}$/;

/** True when the filter hides commits, so graph edges can not be drawn reliably (IntelliJ draws them dashed). */
export function isStructureBroken(f: LogFilters): boolean {
  return !!(f.text || f.users.length || f.since || f.until);
}

export function logArgs(f: LogFilters, o: LogOptions): string[] {
  const args: string[] = [];
  args.push(o.sort === 'topo' ? '--topo-order' : '--date-order');
  if (o.firstParent) args.push('--first-parent');
  if (o.noMerges) args.push('--no-merges');
  for (const u of f.users) args.push(`--author=${u}`);
  if (f.since) args.push(`--since=${f.since}`);
  if (f.until) args.push(`--until=${f.until}`);
  if (f.text) {
    args.push(`--grep=${f.text}`);
    if (!f.matchCase) args.push('-i');
    if (f.regex) args.push('-E');
    else args.push('--fixed-strings');
  }
  if (f.lines) args.push(`-L${f.lines.start},${f.lines.end}:${f.lines.path}`, '-s');
  if (f.paths.length && !f.lines) {
    // Parent rewriting keeps the graph connected for path-limited history.
    if (!f.follow) args.push('--parents');
    if (f.follow && f.paths.length === 1) args.push('--follow');
  }
  if (f.branches.length) args.push(...f.branches);
  else args.push('--branches', '--remotes', '--tags', 'HEAD');
  args.push('--');
  if (!f.lines) args.push(...f.paths);
  return args;
}

/** Short description used in the tab title ("Log: master"). */
export function filtersTitle(f: LogFilters): string {
  if (f.lines) return `${f.lines.path.slice(f.lines.path.lastIndexOf('/') + 1)}:${f.lines.start}-${f.lines.end}`;
  if (f.follow && f.paths.length === 1) return f.paths[0].slice(f.paths[0].lastIndexOf('/') + 1);
  if (f.branches.length) return f.branches.join(', ');
  return '';
}
