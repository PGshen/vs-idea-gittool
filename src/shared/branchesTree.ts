// Rows of the Branches tab (IntelliJ's GitBranchesTreePopup as a flat, expandable list). Pure functions, shared by
// the webview and the tests. Keep this file free of imports other than types.
import type { ActionItem, BranchesRepo, BranchesState, BranchRef } from './branchesProtocol';

export type BranchRow =
  | { kind: 'action'; id: string; item: ActionItem; match?: number[] }
  | { kind: 'separator'; id: string }
  | { kind: 'section'; id: string; label: string; depth: number; expanded: boolean }
  | { kind: 'folder'; id: string; label: string; depth: number; expanded: boolean }
  | { kind: 'repo'; id: string; label: string; hint?: string; depth: number; expanded: boolean }
  | { kind: 'branch'; id: string; depth: number; ref: BranchRef; root?: string; label: string; match?: number[] }
  | { kind: 'empty'; id: string; label: string };

/**
 * Speed search matcher: a substring match, otherwise the query letters in order (IntelliJ's MinusculeMatcher
 * accepts both). Returns the matched character indexes, or undefined when the text does not match.
 */
export function matchText(text: string, query: string): number[] | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return [...Array(q.length).keys()].map(i => at + i);
  const out: number[] = [];
  let i = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const j = t.indexOf(ch, i);
    if (j < 0) return undefined;
    out.push(j);
    i = j + 1;
  }
  return out;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  refs: { ref: BranchRef; leaf: string; match?: number[] }[];
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** Compares branch, tag and folder names with digit runs as numbers, so `3.2` sorts before `3.10`. */
export function compareRefNames(a: string, b: string) {
  return collator.compare(a, b);
}

function sortRefs(a: BranchRef, b: BranchRef) {
  if (!!a.current !== !!b.current) return a.current ? -1 : 1;
  if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
  return compareRefNames(a.name, b.name);
}

export interface TreeOptions {
  query: string;
  /** Expanded state overrides by row id; rows not listed use their default. */
  expanded: Record<string, boolean>;
}

/** Builds the visible rows. */
export function buildBranchRows(state: BranchesState, o: TreeOptions): BranchRow[] {
  const rows: BranchRow[] = [];
  const q = o.query.trim();
  const searching = q.length > 0;
  const isOpen = (id: string, def: boolean) => (searching ? true : (o.expanded[id] ?? def));

  // Top actions.
  const actions: BranchRow[] = [];
  for (const [i, item] of state.top.entries()) {
    if (item.separator) {
      if (!searching) actions.push({ kind: 'separator', id: `sep:top:${i}` });
      continue;
    }
    if (searching) {
      if (!state.settings.searchActions) continue;
      const m = matchText(item.label, q);
      if (!m) continue;
      actions.push({ kind: 'action', id: `action:${item.label}`, item, match: m });
    } else actions.push({ kind: 'action', id: `action:${item.label}`, item });
  }
  rows.push(...actions);
  if (actions.length && !(actions[actions.length - 1].kind === 'separator')) rows.push({ kind: 'separator', id: 'sep:top:end' });

  const before = rows.length;
  const s = state.settings;

  /** Adds the rows of a list of refs, grouped by directory. `strip` removes a prefix (the remote name). */
  const addRefs = (refs: BranchRef[], scope: string, depth: number, root: string | undefined, opts: { strip?: string; currentBranchDirOpen?: boolean } = {}) => {
    const top: Dir = { name: '', path: '', dirs: new Map(), refs: [] };
    for (const ref of refs) {
      const name = opts.strip && ref.name.startsWith(opts.strip + '/') ? ref.name.slice(opts.strip.length + 1) : ref.name;
      let match: number[] | undefined;
      if (searching) {
        match = matchText(name, q);
        if (!match) continue;
      }
      const parts = s.groupByDirectory ? name.split('/') : [name];
      let d = top;
      let p = '';
      for (const part of parts.slice(0, -1)) {
        p = p ? `${p}/${part}` : part;
        let next = d.dirs.get(part);
        if (!next) d.dirs.set(part, (next = { name: part, path: p, dirs: new Map(), refs: [] }));
        d = next;
      }
      const leafStart = name.length - parts[parts.length - 1].length;
      d.refs.push({ ref, leaf: parts[parts.length - 1], match: match?.filter(i => i >= leafStart).map(i => i - leafStart) });
    }
    const hasCurrent = (d: Dir): boolean => d.refs.some(r => r.ref.current) || [...d.dirs.values()].some(hasCurrent);
    const count = (d: Dir): number => d.refs.length + [...d.dirs.values()].reduce((n, x) => n + count(x), 0);
    const emit = (d: Dir, depth: number) => {
      for (const sub of [...d.dirs.values()].sort((a, b) => compareRefNames(a.name, b.name))) {
        if (count(sub) === 0) continue;
        const id = `${scope}|dir:${sub.path}`;
        const expanded = isOpen(id, hasCurrent(sub));
        rows.push({ kind: 'folder', id, label: sub.name, depth, expanded });
        if (expanded) emit(sub, depth + 1);
      }
      for (const r of [...d.refs].sort((a, b) => sortRefs(a.ref, b.ref))) {
        rows.push({ kind: 'branch', id: `${scope}|${r.ref.fullName}`, depth, ref: r.ref, root, label: r.leaf, match: r.match });
      }
    };
    const n = count(top);
    emit(top, depth);
    return n;
  };

  /** Adds a section header with its refs; the header is dropped when nothing is in it. */
  const section = (label: string, scope: string, depth: number, fill: (depth: number) => number) => {
    const id = `${scope}|section`;
    const expanded = isOpen(id, true);
    const at = rows.length;
    rows.push({ kind: 'section', id, label, depth, expanded });
    if (expanded) {
      const n = fill(depth + 1);
      if (n === 0) rows.splice(at);
    } else {
      // Keep collapsed sections only when they have refs.
      const probe = rows.length;
      const n = fill(depth + 1);
      rows.splice(probe);
      if (n === 0) rows.splice(at);
    }
  };

  const repoSections = (repo: BranchesRepo, root: string | undefined, depth: number, scopePrefix: string, withRecent: boolean) => {
    const locals = repo.refs.filter(r => r.type === 'local');
    if (withRecent && s.showRecent && repo.recent.length) {
      const recent = repo.recent.map(n => locals.find(l => l.name === n)).filter((r): r is BranchRef => !!r);
      section('Recent', `${scopePrefix}recent`, depth, d => addRefs(recent, `${scopePrefix}recent`, d, root));
    }
    section('Local', `${scopePrefix}local`, depth, d => addRefs(locals, `${scopePrefix}local`, d, root));
    const remotes = repo.refs.filter(r => r.type === 'remote');
    section('Remote', `${scopePrefix}remote`, depth, d => {
      let n = 0;
      const byRemote = new Map<string, BranchRef[]>();
      for (const r of remotes) {
        const name = r.remote ?? r.name.split('/')[0];
        byRemote.set(name, [...(byRemote.get(name) ?? []), r]);
      }
      for (const [remote, refs] of [...byRemote].sort((a, b) => compareRefNames(a[0], b[0]))) {
        if (!s.groupByDirectory) {
          n += addRefs(refs, `${scopePrefix}remote`, d, root);
          continue;
        }
        const id = `${scopePrefix}remote|remote:${remote}`;
        const expanded = isOpen(id, true);
        const at = rows.length;
        rows.push({ kind: 'folder', id, label: remote, depth: d, expanded });
        const probe = rows.length;
        const c = addRefs(refs, `${scopePrefix}remote|${remote}`, d + 1, root, { strip: remote });
        if (!expanded) rows.splice(probe);
        if (c === 0) rows.splice(at);
        n += c;
      }
      return n;
    });
    if (s.showTags) {
      const tags = repo.refs.filter(r => r.type === 'tag');
      section('Tags', `${scopePrefix}tags`, depth, d => addRefs(tags, `${scopePrefix}tags`, d, root));
    }
  };

  const repos = state.repos;
  if (repos.length === 1) {
    repoSections(repos[0], repos[0].root, 0, '', true);
  } else if (state.sync) {
    // Branches present in every repository first; their actions run in all repositories.
    const common: BranchesRepo = { root: '', name: '', operation: 'none', recent: [], refs: state.common };
    repoSections(common, undefined, 0, '*|', false);
    for (const repo of repos) {
      const id = `${repo.root}|repo`;
      const expanded = isOpen(id, false);
      rows.push({ kind: 'repo', id, label: repo.name, hint: repo.branch, depth: 0, expanded });
      const at = rows.length;
      repoSections(repo, repo.root, 1, `${repo.root}|`, true);
      if (!expanded) rows.splice(at);
    }
  } else {
    for (const repo of repos) {
      const id = `${repo.root}|repo`;
      const expanded = isOpen(id, true);
      rows.push({ kind: 'repo', id, label: repo.name, hint: repo.branch, depth: 0, expanded });
      const at = rows.length;
      repoSections(repo, repo.root, 1, `${repo.root}|`, true);
      if (!expanded) rows.splice(at);
    }
  }
  if (searching && rows.length === before && !rows.some(r => r.kind === 'action')) {
    rows.push({ kind: 'empty', id: 'empty', label: 'Nothing found' });
  } else if (searching && rows.length === before) {
    rows.push({ kind: 'empty', id: 'empty', label: 'Branch not found' });
  }
  // A trailing separator after the actions looks odd when nothing follows.
  while (rows.length && rows[rows.length - 1].kind === 'separator') rows.pop();
  return rows;
}
