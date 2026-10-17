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
  /** Multi-repository log: roots to show. Empty or missing = all roots (IntelliJ "Roots" in the Paths filter). */
  roots?: string[];
}

export interface LogOptions {
  sort: 'topo' | 'date';
  firstParent: boolean;
  noMerges?: boolean;
  /** Graph Options > Collapse Linear Branches. */
  collapseLinear?: boolean;
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

/** Minimal view of a repository needed to translate filters. */
export interface RepoLike {
  root: string;
  refs: { name: string; fullName: string }[];
}

/**
 * Filters for one repository of a multi-repository log, or undefined when the repository shows nothing.
 * Branch items that do not exist in the repository are dropped (IntelliJ applies the branch filter per root).
 * Absolute paths are made relative to the repository; relative paths belong to `primaryRoot`.
 */
export function filtersForRepo(f: LogFilters, repo: RepoLike, primaryRoot: string): LogFilters | undefined {
  if (f.roots?.length && !f.roots.includes(repo.root)) return undefined;
  let branches = f.branches;
  if (branches.length) {
    branches = branches.filter(b => b === 'HEAD' || /\.\.|[\^~]/.test(b) || HASH_RE.test(b) || repo.refs.some(r => r.name === b || r.fullName === b));
    if (!branches.length) return undefined;
  }
  let paths = f.paths;
  if (paths.length) {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
    const root = norm(repo.root);
    paths = paths
      .map(p => {
        const abs = isAbsolute(p) ? norm(p) : repo.root === primaryRoot ? `${root}/${p}` : undefined;
        if (!abs) return undefined;
        if (abs === root) return '.';
        return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : undefined;
      })
      .filter((p): p is string => p !== undefined);
    if (!paths.length) return undefined;
  }
  return { ...f, branches, paths };
}

function isAbsolute(p: string) {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Short description used in the tab title ("Log: master"). */
export function filtersTitle(f: LogFilters): string {
  if (f.lines) return `${f.lines.path.slice(f.lines.path.lastIndexOf('/') + 1)}:${f.lines.start}-${f.lines.end}`;
  if (f.follow && f.paths.length === 1) return f.paths[0].slice(f.paths[0].lastIndexOf('/') + 1);
  if (f.branches.length) return f.branches.join(', ');
  return '';
}
