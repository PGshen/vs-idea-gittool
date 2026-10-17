import { useEffect, useRef, useState } from 'preact/hooks';
import type { LogFiltersDto } from '../../shared/logProtocol';
import { ActionButton } from '../lib/components';
import { Icon } from '../lib/icons';
import { anchorBelow, MenuEntry, showMenu } from '../lib/menu';
import { call, persist, persisted } from '../lib/rpc';
import { graphOptionsMenu, runCommitAction, viewOptionsMenu } from './menus';
import { store, useStore } from './store';

function recent(key: string): string[][] {
  return persisted<string[][]>(`recent:${key}`, []);
}

function remember(key: string, value: string[]) {
  if (!value.length) return;
  const list = recent(key).filter(v => JSON.stringify(v) !== JSON.stringify(value));
  persist(`recent:${key}`, [value, ...list].slice(0, 5));
}

function setFilter(patch: Partial<LogFiltersDto>) {
  void store.setFilters({ ...store.filters, ...patch });
}

/** One filter component: "Branch", or "Branch: master ×" when set (VcsLogPopupComponent). */
function FilterChip({ name, value, onOpen, onClear, tip }: { name: string; value?: string; onOpen: (el: HTMLElement) => void; onClear: () => void; tip: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span class={`filter-chip ${value ? 'active' : ''}`} ref={ref} data-tip={tip} onClick={() => onOpen(ref.current!)}>
      {value ? (
        <>
          <span>{name}:&nbsp;</span>
          <span class="value">{value}</span>
          <span
            class="clear"
            data-tip="Clear"
            onClick={e => {
              e.stopPropagation();
              onClear();
            }}
          >
            <Icon name="general/closeSmall" />
          </span>
        </>
      ) : (
        <>
          <span>{name}</span>
          <Icon name="general/chevronDown" />
        </>
      )}
    </span>
  );
}

function SearchField() {
  const s = useStore();
  const [text, setText] = useState(s.filters.text);
  const timer = useRef<number>();
  useEffect(() => setText(s.filters.text), [s.filters.text]);
  const apply = (t: string) => {
    clearTimeout(timer.current);
    if (t !== store.filters.text) setFilter({ text: t });
  };
  return (
    <div class="search-field" data-tip="Filter by Commit Message or Hashes">
      <Icon name="general/search" />
      <input
        id="text-filter"
        placeholder="Text or hash"
        value={text}
        spellcheck={false}
        onInput={e => {
          const v = (e.currentTarget as HTMLInputElement).value;
          setText(v);
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => apply(v), 600);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') apply(text);
          else if (e.key === 'Escape') {
            if (text) {
              setText('');
              apply('');
            } else document.getElementById('log-table')?.focus();
          } else if (e.key === 'ArrowDown') document.getElementById('log-table')?.focus();
        }}
      />
      {text && (
        <button class="inline-toggle" data-tip="Clear" onClick={() => (setText(''), apply(''))}>
          <Icon name="general/closeSmall" />
        </button>
      )}
      <button class={`inline-toggle ${s.filters.regex ? 'on' : ''}`} data-tip="Regex" onClick={() => setFilter({ regex: !s.filters.regex })}>
        <Icon name="inline/regex" />
      </button>
      <button class={`inline-toggle ${s.filters.matchCase ? 'on' : ''}`} data-tip="Match Case" onClick={() => setFilter({ matchCase: !s.filters.matchCase })}>
        <Icon name="inline/matchCase" />
      </button>
    </div>
  );
}

function branchMenu(): MenuEntry[] {
  const refs = store.refs;
  const pick = (v: string[]) => () => {
    remember('branch', v);
    setFilter({ branches: v });
  };
  const locals = refs.filter(r => r.type === 'local');
  const remotes = refs.filter(r => r.type === 'remote');
  const tags = refs.filter(r => r.type === 'tag');
  const favorites = refs.filter(r => r.favorite).map(r => r.name);
  const rec = recent('branch');
  const entries: MenuEntry[] = [
    {
      label: 'Select…',
      action: async () => {
        const v = await call<string[] | undefined>('pickBranches');
        if (v?.length) pick(v)();
      },
    },
    { separator: true },
    { label: 'HEAD', action: pick(['HEAD']) },
  ];
  if (favorites.length) entries.push({ label: 'Favorites', hint: favorites.join(', '), action: pick(favorites) });
  if (rec.length) {
    entries.push({ separator: true, label: 'Recent' });
    for (const r of rec) entries.push({ label: r.join(', '), action: pick(r) });
  }
  entries.push({ separator: true });
  entries.push({ label: 'Local', children: locals.map(r => ({ label: r.name, icon: r.favorite ? 'nodes/star' : undefined, action: pick([r.name]) })) });
  const byRemote = new Map<string, string[]>();
  for (const r of remotes) byRemote.set(r.remote ?? '', [...(byRemote.get(r.remote ?? '') ?? []), r.name]);
  for (const [remote, names] of byRemote) entries.push({ label: remote, children: names.map(n => ({ label: n, action: pick([n]) })) });
  if (tags.length) entries.push({ label: 'Tags', children: tags.map(r => ({ label: r.name, icon: 'nodes/tag', action: pick([r.name]) })) });
  return entries;
}

async function userMenu(): Promise<MenuEntry[]> {
  const authors = await call<string[]>('authors');
  const pick = (v: string[]) => () => {
    remember('user', v);
    setFilter({ users: v });
  };
  const rec = recent('user');
  const entries: MenuEntry[] = [
    {
      label: 'Select…',
      action: async () => {
        const v = await call<string | undefined>('input', { title: 'Filter by User', prompt: 'Select one or more values separated with commas', value: store.filters.users.join(', ') });
        if (v) pick(v.split(',').map(x => x.trim()).filter(Boolean))();
      },
    },
    { separator: true },
    { label: 'me', action: pick(['me']) },
  ];
  if (rec.length) {
    entries.push({ separator: true, label: 'Recent' });
    for (const r of rec) entries.push({ label: r.join(', '), action: pick(r) });
  }
  entries.push({ separator: true });
  for (const a of authors) {
    const name = a.replace(/\s*<.*>$/, '');
    entries.push({ label: name, hint: /<(.*)>/.exec(a)?.[1], action: pick([name]) });
  }
  return entries;
}

function dateMenu(): MenuEntry[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    { label: 'Last 24 hours', action: () => setFilter({ since: now - 86400, until: undefined }) },
    { label: 'Last 7 days', action: () => setFilter({ since: now - 7 * 86400, until: undefined }) },
    {
      label: 'Select…',
      action: async () => {
        const since = await call<number | undefined>('pickDate', { which: 'since' });
        if (since === undefined) return;
        const until = await call<number | undefined>('pickDate', { which: 'until' });
        setFilter({ since, until });
      },
    },
  ];
}

function pathsMenu(): MenuEntry[] {
  const rec = recent('paths');
  const entries: MenuEntry[] = [
    {
      label: 'Select…',
      action: async () => {
        const v = await call<string[] | undefined>('pickPaths');
        if (v?.length) {
          remember('paths', v);
          setFilter({ paths: v });
        }
      },
    },
  ];
  if (rec.length) {
    entries.push({ separator: true, label: 'Recent' });
    for (const r of rec) entries.push({ label: r.join(', '), action: () => setFilter({ paths: r }) });
  }
  if (store.init.multi) {
    // Roots of the multi-root log (VcsLogStructureFilter roots). Shown roots are checked.
    const all = store.repos.map(r => r.root);
    const shown = store.filters.roots?.length ? store.filters.roots : all;
    entries.push({ separator: true, label: 'Roots' });
    for (const r of store.repos) {
      const on = shown.includes(r.root);
      entries.push({
        label: r.name,
        checked: on,
        hint: r.root,
        action: () => {
          const next = on ? shown.filter(x => x !== r.root) : [...shown, r.root];
          if (!next.length) return;
          setFilter({ roots: next.length === all.length ? [] : next });
        },
      });
    }
  }
  return entries;
}

function pathsText(f: LogFiltersDto): string | undefined {
  const names = (f.roots ?? []).map(root => store.repos.find(r => r.root === root)?.name ?? root);
  const paths = f.paths.map(p => (p.startsWith('/') || /^[a-zA-Z]:/.test(p) ? p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1) : p));
  const all = [...names, ...paths];
  return all.length ? all.join(', ') : undefined;
}

function dateText(f: LogFiltersDto) {
  const d = (t: number) => new Date(t * 1000).toLocaleDateString();
  const now = Date.now() / 1000;
  if (f.since && !f.until) {
    if (Math.abs(now - 86400 - f.since) < 120) return 'Last 24 hours';
    if (Math.abs(now - 7 * 86400 - f.since) < 120) return 'Last 7 days';
    return `Since ${d(f.since)}`;
  }
  if (f.since && f.until) return `${d(f.since)} - ${d(f.until)}`;
  if (f.until) return `Until ${d(f.until)}`;
  return undefined;
}

/** Left part of the log toolbar: text filter, filter components, graph options and new tab. */
export function FilterBar({ onGoTo }: { onGoTo: () => void }) {
  const s = useStore();
  const f = s.filters;
  const graphRef = useRef<HTMLSpanElement>(null);
  const history = s.init.mode === 'history';
  const selectedNotInHead = s.selectedRows().some(r => !r.b);
  return (
    <div class="filter-bar">
      <div class="filters">
        <SearchField />
        <FilterChip
          name="Branch"
          tip="Filter by Branch"
          value={f.branches.length ? f.branches.join(', ') : undefined}
          onOpen={el => showMenu(branchMenu(), anchorBelow(el))}
          onClear={() => setFilter({ branches: [] })}
        />
        {!history && <FilterChip name="User" tip="Filter by User" value={f.users.length ? f.users.join(', ') : undefined} onOpen={async el => showMenu(await userMenu(), anchorBelow(el))} onClear={() => setFilter({ users: [] })} />}
        {!history && <FilterChip name="Date" tip="Filter by Date" value={dateText(f)} onOpen={el => showMenu(dateMenu(), anchorBelow(el))} onClear={() => setFilter({ since: undefined, until: undefined })} />}
        {!history && (
          <FilterChip name="Paths" tip="Filter by Paths" value={pathsText(f)} onOpen={el => showMenu(pathsMenu(), anchorBelow(el))} onClear={() => setFilter({ paths: [], roots: [] })} />
        )}
        {!history && (
          <span ref={graphRef}>
            <ActionButton icon="vcslog/intelliSort" tip="Graph Options" toggled={s.options.sort !== 'date' || s.options.firstParent || !!s.options.noMerges || !!s.options.collapseLinear} menu={graphOptionsMenu} />
          </span>
        )}
        {!history && <span class="toolbar-separator" />}
        {!history && <ActionButton icon="general/openNewTab" tip="Open New Git Log Tab" shortcut="Alt+G" onClick={() => void call('newTab', { filters: store.filters })} />}
      </div>
      {history ? (
        <>
          <ActionButton icon="general/refresh" tip="Refresh" onClick={() => void call('refreshRepo').then(() => store.setFilters(store.filters))} />
          <ActionButton icon="vcs/diff" tip="Show Diff" shortcut="Ctrl+D" disabled={!s.selection.size} onClick={() => runCommitAction('historyDiff')} />
          <ActionButton icon="vcs/changes" tip="Show All Affected Files" shortcut="Alt+Shift+A" disabled={s.selection.size !== 1} onClick={() => runCommitAction('showDiff')} />
          <ActionButton icon="general/show" tip="View Options" menu={viewOptionsMenu} />
          <ActionButton icon="toolwindows/vcs" tip="Show in VCS Log" disabled={s.selection.size !== 1} onClick={() => runCommitAction('showInLog')} />
        </>
      ) : (
        <>
          <ActionButton icon="general/refresh" tip="Refresh" shortcut="Ctrl+F5" onClick={() => void call('refreshRepo').then(() => store.setFilters(store.filters))} />
          <ActionButton icon="dvcs/cherryPick" tip="Cherry-Pick" disabled={!selectedNotInHead || s.head.operation !== 'none'} onClick={() => runCommitAction('cherryPick')} />
          <ActionButton icon="general/show" tip="View Options" menu={viewOptionsMenu} />
          <ActionButton icon="general/search" tip="Go To Hash/Branch/Tag" shortcut="Ctrl+F" onClick={onGoTo} />
        </>
      )}
    </div>
  );
}
