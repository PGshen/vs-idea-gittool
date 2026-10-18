import { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ActionItem, BranchesState, BranchRef, RefAddress } from '../../shared/branchesProtocol';
import { BranchRow, buildBranchRows } from '../../shared/branchesTree';
import { ActionButton } from '../lib/components';
import { Icon } from '../lib/icons';
import { Anchor, MenuEntry, showMenu } from '../lib/menu';
import { call, on, persist, persisted, send } from '../lib/rpc';

const ROW = 24;
const SEP = 9;
const INDENT = 18;

function rowHeight(r: BranchRow) {
  return r.kind === 'separator' ? SEP : ROW;
}

function Highlighted({ text, match }: { text: string; match?: number[] }) {
  if (!match || match.length === 0) return <>{text}</>;
  const set = new Set(match);
  const out: ComponentChildren[] = [];
  let run = '';
  let inMatch = false;
  const flush = () => {
    if (!run) return;
    out.push(inMatch ? <span class="match">{run}</span> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) {
      flush();
      inMatch = m;
    }
    run += text[i];
  }
  flush();
  return <>{out}</>;
}

function refIcon(ref: BranchRef) {
  if (ref.type === 'tag') return 'nodes/tag';
  if (ref.current) return ref.favorite ? 'dvcs/currentBranchFavoriteLabel' : 'dvcs/currentBranchLabel';
  if (ref.favorite) return 'nodes/star';
  return 'general/vcs';
}

function address(r: Extract<BranchRow, { kind: 'branch' }>): RefAddress {
  return { root: r.root, name: r.ref.name, type: r.ref.type };
}

/**
 * The Branches tab: IntelliJ's Git branches popup (GitBranchesTreePopup) as a tab of the Commit tool window.
 * Search field with Fetch and settings, top actions, then Recent / Local / Remote / Tags.
 */
export function BranchesTab({ visible, focusToken }: { visible: boolean; focusToken: number }) {
  const [state, setState] = useState<BranchesState | undefined>();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => persisted('branches.expanded', {}));
  const [selected, setSelected] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clickTimer = useRef<number | undefined>();

  useEffect(() => {
    call<BranchesState>('branches.ready').then(setState);
    return on('branches', setState);
  }, []);
  // Focus the search field when the tab is opened by a command. VS Code focuses the webview frame only after the
  // message arrived, so the request is repeated when the frame gets the focus.
  useEffect(() => {
    if (!visible || !focusToken) return;
    const focus = () => searchRef.current?.focus();
    focus();
    const t = window.setTimeout(focus, 150);
    window.addEventListener('focus', focus);
    const stop = window.setTimeout(() => window.removeEventListener('focus', focus), 1500);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(stop);
      window.removeEventListener('focus', focus);
    };
  }, [focusToken, visible]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [state === undefined]);

  const rows = useMemo(() => (state ? buildBranchRows(state, { query, expanded }) : []), [state, query, expanded]);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const r of rows) {
      out.push(y);
      y += rowHeight(r);
    }
    out.push(y);
    return out;
  }, [rows]);
  const selectable = (r: BranchRow) => r.kind !== 'separator' && r.kind !== 'empty';

  // Searching selects the first branch (or action) that matches, like the popup.
  useEffect(() => {
    if (!query) return;
    const first = rows.find(r => r.kind === 'branch') ?? rows.find(selectable);
    setSelected(first?.id);
  }, [query, state]);

  const index = rows.findIndex(r => r.id === selected);

  const scrollTo = (i: number) => {
    const el = listRef.current;
    if (!el || i < 0) return;
    const top = offsets[i];
    const bottom = offsets[i + 1];
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  const select = (i: number) => {
    const r = rows[i];
    if (!r) return;
    setSelected(r.id);
    scrollTo(i);
  };

  const move = (dir: 1 | -1) => {
    let i = index;
    for (let n = 0; n < rows.length; n++) {
      i = i < 0 ? (dir === 1 ? 0 : rows.length - 1) : (i + dir + rows.length) % rows.length;
      if (selectable(rows[i])) break;
    }
    select(i);
  };

  const setOpen = (id: string, open: boolean) => {
    const next = { ...expanded, [id]: open };
    setExpanded(next);
    persist('branches.expanded', next);
  };

  const runAction = (item: ActionItem) => {
    if (item.action) send('branches.runTop', { action: item.action });
  };

  const openRefMenu = async (r: Extract<BranchRow, { kind: 'branch' }>, anchor: Anchor) => {
    setSelected(r.id);
    const addr = address(r);
    const items = await call<ActionItem[]>('branches.refActions', addr);
    const entries: MenuEntry[] = items.map(it =>
      it.separator
        ? { separator: true }
        : { label: it.label, icon: it.icon, shortcut: it.shortcut, action: () => send('branches.runRef', { ...addr, action: it.action }) },
    );
    showMenu(entries, anchor, { onClose: () => listRef.current?.focus() });
  };

  const rowAnchor = (id: string): Anchor => {
    const el = listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const rect = el?.getBoundingClientRect();
    return rect ? { x: rect.right - 4, y: rect.top - 6, flipHeight: -rect.height } : { x: 40, y: 40 };
  };

  const activate = (r: BranchRow) => {
    switch (r.kind) {
      case 'action':
        return runAction(r.item);
      case 'section':
      case 'folder':
      case 'repo':
        return setOpen(r.id, !r.expanded);
      case 'branch':
        return openRefMenu(r, rowAnchor(r.id));
    }
  };

  const checkout = (r: Extract<BranchRow, { kind: 'branch' }>) => {
    if (r.ref.current) return;
    send('branches.runRef', { ...address(r), action: r.ref.type === 'tag' ? 'ideagittool.tag.checkout' : 'ideagittool.branch.checkout' });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const r = rows[index];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault();
        const page = Math.max(1, Math.floor(height / ROW) - 1);
        let i = Math.max(0, Math.min(rows.length - 1, index + (e.key === 'PageDown' ? page : -page)));
        while (rows[i] && !selectable(rows[i])) i += e.key === 'PageDown' ? -1 : 1;
        select(i);
        return;
      }
      case 'Enter':
        if (r) {
          e.preventDefault();
          activate(r);
        }
        return;
      case 'ArrowRight':
        if (!r || e.target === searchRef.current && searchRef.current!.selectionStart !== searchRef.current!.value.length) return;
        if (r.kind === 'branch') {
          e.preventDefault();
          void openRefMenu(r, rowAnchor(r.id));
        } else if ((r.kind === 'section' || r.kind === 'folder' || r.kind === 'repo') && !r.expanded) {
          e.preventDefault();
          setOpen(r.id, true);
        }
        return;
      case 'ArrowLeft': {
        if (!r || e.target === searchRef.current && searchRef.current!.selectionStart !== 0) return;
        if ((r.kind === 'section' || r.kind === 'folder' || r.kind === 'repo') && r.expanded && !query) {
          e.preventDefault();
          setOpen(r.id, false);
          return;
        }
        const depth = 'depth' in r ? r.depth : 0;
        for (let j = index - 1; j >= 0; j--) {
          const p = rows[j];
          if ((p.kind === 'section' || p.kind === 'folder' || p.kind === 'repo') && p.depth < depth) {
            e.preventDefault();
            select(j);
            return;
          }
        }
        return;
      }
      case 'Escape':
        if (query) {
          e.preventDefault();
          setQuery('');
        }
        return;
      default:
        // Typing in the list goes to the search field (speed search).
        if (e.target !== searchRef.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          searchRef.current?.focus();
        }
    }
  };

  const first = Math.max(0, offsets.findIndex(y => y >= scrollTop) - 4);
  let last = first;
  while (last < rows.length && offsets[last] < scrollTop + height + ROW * 4) last++;

  if (!state) {
    return (
      <div class="branches-tab">
        <div class="empty-text">Loading…</div>
      </div>
    );
  }
  const s = state.settings;
  const multi = state.repos.length > 1;
  const placeholder = `Search for branches${s.searchActions ? ', actions' : ''}${multi ? ' and repositories' : ''}`.replace(/, actions$/, ' and actions');

  return (
    <div class="branches-tab" onKeyDown={onKeyDown}>
      <div class="branches-search">
        <Icon name="general/search" />
        <input
          ref={searchRef}
          class="branches-search-input"
          placeholder={placeholder}
          value={query}
          spellcheck={false}
          onInput={e => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        {state.fetching ? (
          <span class="branches-fetching" data-tip="Fetching…">
            <span class="spinner" />
          </span>
        ) : (
          <ActionButton icon="vcs/fetch" tip="Fetch" onClick={() => send('branches.fetch')} />
        )}
        <ActionButton
          icon="general/settings"
          tip="Settings"
          menu={() => [
            { separator: true, label: 'Add in Search Results' },
            { label: 'Actions', checked: s.searchActions, action: () => send('branches.setSetting', { key: 'searchActions', value: !s.searchActions }) },
            { separator: true },
            { label: 'Group by Directory', icon: 'actions/groupByPackage', checked: s.groupByDirectory, action: () => send('branches.setSetting', { key: 'groupByDirectory', value: !s.groupByDirectory }) },
            ...(multi
              ? [
                  { label: 'Group by Repository', checked: s.groupByRepository, action: () => send('branches.setSetting', { key: 'groupByRepository', value: !s.groupByRepository }) },
                  { label: 'Execute Branch Operations on All Roots', checked: s.syncControl, action: () => send('branches.setSetting', { key: 'syncControl', value: !s.syncControl }) },
                ]
              : []),
            { label: 'Show Recent Branches', checked: s.showRecent, action: () => send('branches.setSetting', { key: 'showRecent', value: !s.showRecent }) },
            { label: 'Show Tags', checked: s.showTags, action: () => send('branches.setSetting', { key: 'showTags', value: !s.showTags }) },
          ]}
        />
      </div>
      <div class="branches-header-sep" />
      <div class="branches-list" ref={listRef} tabIndex={0} onScroll={e => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}>
        <div style={{ height: `${offsets[rows.length]}px`, position: 'relative' }}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const style = { top: `${offsets[i]}px` };
            if (r.kind === 'separator') return <div key={r.id} class="branches-sep" style={style} />;
            if (r.kind === 'empty')
              return (
                <div key={r.id} class="branches-row empty" style={style}>
                  {r.label}
                </div>
              );
            const sel = r.id === selected;
            const cls = `branches-row ${sel ? 'selected' : ''}`;
            const common = {
              key: r.id,
              'data-id': r.id,
              class: cls,
              style,
              onMouseEnter: () => setHover(r.id),
              onMouseLeave: () => setHover(h => (h === r.id ? undefined : h)),
            };
            if (r.kind === 'action') {
              return (
                <div {...common} class={`${cls} action`} onClick={() => (setSelected(r.id), runAction(r.item))}>
                  <span class="branches-icon">{r.item.icon && <Icon name={r.item.icon} />}</span>
                  <span class="branches-label">
                    <Highlighted text={r.item.label} match={r.match} />
                  </span>
                  {r.item.shortcut && <span class="branches-shortcut">{r.item.shortcut}</span>}
                </div>
              );
            }
            const pad = { paddingLeft: `${12 + r.depth * INDENT}px` };
            if (r.kind === 'section' || r.kind === 'folder' || r.kind === 'repo') {
              return (
                <div {...common} style={{ ...style, ...pad }} onClick={() => (setSelected(r.id), setOpen(r.id, !r.expanded))}>
                  <span class="branches-chevron">
                    <Icon name={r.expanded ? 'general/chevronDown' : 'general/chevronRight'} />
                  </span>
                  {r.kind !== 'section' && <Icon name="nodes/folder" />}
                  <span class="branches-label">{r.label}</span>
                  {r.kind === 'repo' && r.hint && <span class="branches-hint">{r.hint}</span>}
                </div>
              );
            }
            const ref = r.ref;
            const canStar = ref.type !== 'tag';
            const showEmptyStar = canStar && !ref.favorite && !ref.current && hover === r.id;
            return (
              <div
                {...common}
                style={{ ...style, ...pad }}
                class={`${cls} branch ${ref.current ? 'current' : ''}`}
                onClick={e => {
                  setSelected(r.id);
                  window.clearTimeout(clickTimer.current);
                  const anchor = rowAnchor(r.id);
                  if (e.detail > 1) return;
                  clickTimer.current = window.setTimeout(() => void openRefMenu(r, anchor), 220);
                }}
                onDblClick={() => {
                  window.clearTimeout(clickTimer.current);
                  checkout(r);
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  void openRefMenu(r, { x: e.clientX, y: e.clientY });
                }}
              >
                <span class="branches-chevron" />
                <span
                  class={`branches-icon ${canStar ? 'star-toggle' : ''}`}
                  data-tip={canStar ? (ref.favorite ? 'Remove from Favorites' : 'Add to Favorites') : undefined}
                  onClick={e => {
                    if (!canStar) return;
                    e.stopPropagation();
                    window.clearTimeout(clickTimer.current);
                    send('branches.toggleFavorite', address(r));
                  }}
                >
                  <Icon name={showEmptyStar ? 'nodes/starEmpty' : refIcon(ref)} />
                </span>
                <span class="branches-label" data-tip={ref.upstream ? `${ref.name} → ${ref.upstream}` : undefined}>
                  <Highlighted text={r.label} match={r.match} />
                </span>
                {ref.behind || ref.ahead ? (
                  <span class="branches-inout" data-tip={[ref.behind ? `${ref.behind} incoming` : '', ref.ahead ? `${ref.ahead} outgoing` : ''].filter(Boolean).join(', ')}>
                    {ref.behind ? (
                      <>
                        <Icon name="dvcs/changesUpdate@12x12" size={12} />
                        {ref.behind}
                      </>
                    ) : null}
                    {ref.ahead ? (
                      <>
                        <Icon name="dvcs/changesPush@12x12" size={12} />
                        {ref.ahead}
                      </>
                    ) : null}
                  </span>
                ) : null}
                <span class="branches-spacer" />
                <span
                  class="branches-more"
                  onClick={e => {
                    e.stopPropagation();
                    window.clearTimeout(clickTimer.current);
                    void openRefMenu(r, rowAnchor(r.id));
                  }}
                >
                  <Icon name="general/chevronRight" />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
