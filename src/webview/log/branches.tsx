import { useEffect, useMemo, useState } from 'preact/hooks';
import { compareRefNames } from '../../shared/branchesTree';
import type { Ref } from '../../shared/types';
import { ActionButton, Toolbar, Tree, TreeNode } from '../lib/components';
import { Icon } from '../lib/icons';
import { t } from '../lib/l10n';
import { anchorAt, MenuEntry, showMenu } from '../lib/menu';
import { call, persist, persisted, send } from '../lib/rpc';
import { refActions } from './menus';
import { RefIcon } from './refs';
import { store, useStore } from './store';

type Node = TreeNode<{ ref?: Ref; group?: string; remote?: string; root?: string }>;

function groupByDirectory(refs: Ref[], prefix: string, nameOf: (r: Ref) => string, makeLeaf: (r: Ref, label: string) => Node, enabled: boolean): Node[] {
  if (!enabled) return refs.map(r => makeLeaf(r, nameOf(r)));
  interface Dir {
    dirs: Map<string, Dir>;
    leaves: { r: Ref; label: string }[];
  }
  const root: Dir = { dirs: new Map(), leaves: [] };
  for (const r of refs) {
    const parts = nameOf(r).split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let n = d.dirs.get(p);
      if (!n) d.dirs.set(p, (n = { dirs: new Map(), leaves: [] }));
      d = n;
    }
    d.leaves.push({ r, label: parts[parts.length - 1] });
  }
  const toNodes = (d: Dir, path: string): Node[] => [
    ...[...d.dirs.entries()]
      .sort((a, b) => compareRefNames(a[0], b[0]))
      .map(([name, sub]) => ({ key: `${prefix}/${path}${name}`, label: name, text: name, icon: 'nodes/folder', children: toNodes(sub, `${path}${name}/`), data: { group: `${path}${name}` } })),
    ...d.leaves.map(l => makeLeaf(l.r, l.label)),
  ];
  return toNodes(root, '');
}

function branchSort(a: Ref, b: Ref) {
  if (a.current !== b.current) return a.current ? -1 : 1;
  if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
  return compareRefNames(a.name, b.name);
}

/** Branches pane of the Git log (BranchesDashboardTreeComponent). */
export function BranchesPanel({ onHide }: { onHide: () => void }) {
  const s = useStore();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(persisted<string[]>('branchesExpanded', ['local', 'remote', 'head'])));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const settings = s.settings;
  const current = s.currentBranch;

  const nodes = useMemo(() => {
    const q = search.toLowerCase();
    const match = (r: Ref) => !q || r.name.toLowerCase().includes(q);
    const leaf = (r: Ref, label: string): Node => {
      const kinds = r.current ? (['head'] as const) : r.type === 'remote' ? (['remote'] as const) : r.type === 'tag' ? (['tag'] as const) : (['local'] as const);
      return {
        key: `ref:${r.root ?? ''}:${r.fullName}`,
        label,
        text: r.name,
        prefix: (
          <span
            class="star"
            data-tip={r.favorite ? t('Remove from Favorites') : t('Add to Favorites')}
            onClick={e => {
              e.stopPropagation();
              send('branchAction', { id: 'toggleFavorite', name: r.name, type: r.type, root: r.root });
            }}
          >
            {r.favorite ? <Icon name="nodes/star" /> : r.type !== 'tag' ? <RefIcon kinds={[...kinds]} /> : <Icon name="nodes/tag" />}
          </span>
        ),
        hint: (
          <>
            {r.ahead || r.behind ? (
              <span class="ab-counts">
                {r.behind ? <span data-tip={t('{0} incoming commits', r.behind)}>↓{r.behind}</span> : null}
                {r.ahead ? <span data-tip={t('{0} outgoing commits', r.ahead)}>↑{r.ahead}</span> : null}
              </span>
            ) : null}
            {r.upstream && <span class="secondary" style={{ marginLeft: '6px' }}>{r.upstream}</span>}
          </>
        ),
        bold: r.current,
        data: { ref: r },
        tip: r.upstream ? `${r.name} → ${r.upstream}` : r.name,
      };
    };
    // Show My Branches: only local branches whose exclusive commits are all mine.
    const mine = (r: Ref) => !settings.showMyBranches || !s.myBranches || s.myBranches.has(s.init.multi ? `${r.root}\0${r.fullName}` : r.fullName);
    const locals = s.refs.filter(r => r.type === 'local' && match(r) && mine(r)).sort(branchSort);
    const remotes = settings.showMyBranches ? [] : s.refs.filter(r => r.type === 'remote' && match(r)).sort(branchSort);
    const tags = s.refs.filter(r => r.type === 'tag' && match(r)).sort((a, b) => compareRefNames(a.name, b.name));
    const byRepo = s.init.multi && settings.branchesGroupByRepository;
    // Group by Repository: an extra level with one node per repository under Local / Remote / Tags.
    const perRepo = (refs: Ref[], prefix: string, build: (list: Ref[], key: string) => Node[]): Node[] =>
      byRepo
        ? s.repos
            .filter(repo => refs.some(r => r.root === repo.root))
            .map(repo => ({
              key: `${prefix}@${repo.root}`,
              label: repo.name,
              text: repo.name,
              icon: 'nodes/folder',
              tip: repo.root,
              data: { group: `${prefix}@${repo.root}` },
              children: build(
                refs.filter(r => r.root === repo.root),
                `${prefix}@${repo.root}`,
              ),
            }))
        : build(refs, prefix);
    const out: Node[] = [];
    const headLabel = current ? t('HEAD (Current Branch)') : t('HEAD (detached at {0})', s.head.hash?.slice(0, 8) ?? '');
    if (!q || 'head'.includes(q)) out.push({ key: 'head', label: headLabel, text: 'HEAD', prefix: <RefIcon kinds={['head']} />, data: {} });
    out.push({
      key: 'local',
      label: t('Local'),
      text: t('Local'),
      icon: 'nodes/folder',
      children: perRepo(locals, 'local', (list, key) => groupByDirectory(list, key, r => r.name, leaf, settings.branchesGroupByDirectory)),
      data: { group: 'local' },
    });
    const remoteNodes = (list: Ref[], key: string): Node[] => {
      const byRemote = new Map<string, Ref[]>();
      for (const r of list) byRemote.set(r.remote ?? '', [...(byRemote.get(r.remote ?? '') ?? []), r]);
      return [...byRemote.entries()].map(([remote, refs]) => ({
        key: `${key}/${remote}`,
        label: remote,
        text: remote,
        icon: 'nodes/folder',
        data: { group: remote, remote, root: refs[0]?.root },
        children: groupByDirectory(refs, `${key}/${remote}`, r => r.name.slice(remote.length + 1), leaf, settings.branchesGroupByDirectory),
      }));
    };
    if (remotes.length || (!q && !settings.showMyBranches && s.refs.some(r => r.type === 'remote')))
      out.push({ key: 'remote', label: t('Remote'), text: t('Remote'), icon: 'nodes/folder', data: { group: 'remote' }, children: perRepo(remotes, 'remote', remoteNodes) });
    if (settings.branchesShowTags)
      out.push({ key: 'tags', label: t('Tags'), text: t('Tags'), icon: 'nodes/folder', data: { group: 'tags' }, children: perRepo(tags, 'tags', list => list.map(x => leaf(x, x.name))) });
    return out;
  }, [s.refs, search, settings.branchesGroupByDirectory, settings.branchesGroupByRepository, settings.branchesShowTags, settings.showMyBranches, s.myBranches, current, s.head.hash, s.repos]);

  useEffect(() => {
    if (settings.showMyBranches && !s.myBranches) void store.loadMyBranches();
  }, [settings.showMyBranches]);

  const effectiveExpanded = useMemo(() => {
    if (!search) return expanded;
    const all = new Set<string>();
    const walk = (ns: Node[]) => ns.forEach(n => n.children && (all.add(n.key), walk(n.children)));
    walk(nodes);
    return all;
  }, [search, expanded, nodes]);

  const selectedRefs = (): Ref[] => {
    const out: Ref[] = [];
    const walk = (ns: Node[]) =>
      ns.forEach(n => {
        if (selection.has(n.key) && n.data?.ref) out.push(n.data.ref);
        if (n.children) walk(n.children);
      });
    walk(nodes);
    return out;
  };

  const filterBy = (n: Node) => {
    if (n.key === 'head') return void store.setFilters({ ...store.filters, branches: ['HEAD'] });
    const r = n.data?.ref;
    if (r) void store.setFilters({ ...store.filters, branches: [r.name] });
    else if (n.data?.group && n.children) {
      const names: string[] = [];
      const walk = (ns: Node[]) => ns.forEach(c => (c.data?.ref ? names.push(c.data.ref.name) : c.children && walk(c.children)));
      walk(n.children);
      if (names.length) void store.setFilters({ ...store.filters, branches: names });
    }
  };

  const navigate = (n: Node) => {
    const hash = n.key === 'head' ? store.head.hash : n.data?.ref?.hash;
    if (!hash) return;
    const i = store.indexOfHash(hash);
    const label = n.key === 'head' ? 'HEAD' : n.data?.ref?.name;
    if (i >= 0) void store.selectIndex(i);
    else void call<{ index: number; hash: string } | undefined>('find', { q: hash, label }).then(r => r && store.selectIndex(r.index, { hash: r.hash }));
  };

  const settingsMenu = (): MenuEntry[] => [
    { separator: true, label: t('On Single Click') },
    { label: t('Update Branch Filter'), checked: settings.branchesSingleClickFilter, action: () => store.updateSettings({ branchesSingleClickFilter: true, branchesSingleClickNavigate: false }) },
    { label: t('Navigate Log to Branch Head'), checked: settings.branchesSingleClickNavigate, action: () => store.updateSettings({ branchesSingleClickNavigate: true, branchesSingleClickFilter: false }) },
    { separator: true },
    { label: t('Group by Directory'), icon: 'actions/groupByPackage', checked: settings.branchesGroupByDirectory, action: () => store.updateSettings({ branchesGroupByDirectory: !settings.branchesGroupByDirectory }) },
    { label: t('Group by Repository'), checked: store.init.multi && settings.branchesGroupByRepository, disabled: !store.init.multi, action: () => store.updateSettings({ branchesGroupByRepository: !settings.branchesGroupByRepository }) },
    { label: t('Show Tags'), checked: settings.branchesShowTags, action: () => store.updateSettings({ branchesShowTags: !settings.branchesShowTags }) },
  ];

  const sel = selectedRefs();
  const one = sel.length === 1 ? sel[0] : undefined;
  return (
    <div class="branches-panel">
      <Toolbar vertical class="branches-toolbar">
        <ActionButton icon="general/chevronLeft" tip={t('Hide Git Branches')} onClick={onHide} />
        <span class="toolbar-separator" style={{ width: '18px', height: '1px', margin: '4px 0' }} />
        <ActionButton icon="general/add" tip={t('New Branch')} shortcut="Ctrl+Alt+N" onClick={() => send('command', { id: 'ideagittool.createBranch', args: { root: store.root, startPoint: one?.name } })} />
        <ActionButton
          icon="vcs/update"
          tip={t('Update Selected')}
          disabled={!sel.some(r => r.type === 'local')}
          onClick={() => sel.filter(r => r.type === 'local').forEach(r => send('branchAction', { id: 'update', name: r.name, type: r.type, root: r.root }))}
        />
        <ActionButton icon="general/delete" tip={sel.length > 1 ? t('Delete Branches') : t('Delete Branch')} disabled={!sel.length || sel.some(r => r.current)} onClick={() => sel.forEach(r => send('branchAction', { id: 'delete', name: r.name, type: r.type, root: r.root }))} />
        <ActionButton icon="vcs/diff" tip={t('Compare with Current')} shortcut="Ctrl+D" disabled={!one || one.current} onClick={() => one && send('branchAction', { id: 'compare', name: one.name, type: one.type, root: one.root })} />
        <ActionButton
          icon="general/search"
          tip={t('Show My Branches')}
          toggled={settings.showMyBranches}
          onClick={() => {
            if (!settings.showMyBranches) void store.loadMyBranches();
            store.updateSettings({ showMyBranches: !settings.showMyBranches });
          }}
        />
        <ActionButton icon="vcs/fetch" tip={t('Fetch')} onClick={() => (store.init.multi ? store.repos : [{ root: store.root }]).forEach(r => send('command', { id: 'ideagittool.fetch', args: { root: r.root } }))} />
        <ActionButton icon="nodes/star" tip={t('Mark/Unmark As Favorite')} disabled={!sel.length || sel.some(r => r.type === 'tag')} onClick={() => sel.forEach(r => send('branchAction', { id: 'toggleFavorite', name: r.name, type: r.type, root: r.root }))} />
        <ActionButton
          icon="general/locate"
          tip={t('Navigate Log to Selected Branch Head')}
          disabled={!one && !selection.has('head')}
          onClick={() => {
            const n = findNode(nodes, [...selection][0]);
            if (n) navigate(n);
          }}
        />
        <span class="toolbar-separator" style={{ width: '18px', height: '1px', margin: '4px 0' }} />
        <ActionButton icon="general/settings" tip={t('Branches Pane Settings')} menu={settingsMenu} />
        <ActionButton icon="general/expandAll" tip={t('Expand All')} onClick={() => {
          const all = new Set<string>();
          const walk = (ns: Node[]) => ns.forEach(n => n.children && (all.add(n.key), walk(n.children)));
          walk(nodes);
          setExpanded(all);
        }} />
        <ActionButton icon="general/collapseAll" tip={t('Collapse All')} onClick={() => setExpanded(new Set())} />
      </Toolbar>
      <div class="branches-body">
        <div class="branches-search">
          <div class="search-field">
            <Icon name="general/search" />
            <input placeholder={t('Search')} value={search} onInput={e => setSearch((e.currentTarget as HTMLInputElement).value)} onKeyDown={e => e.key === 'Escape' && setSearch('')} />
          </div>
        </div>
        <Tree<{ ref?: Ref; group?: string; remote?: string; root?: string }>
          nodes={nodes}
          expanded={effectiveExpanded}
          onExpandedChange={e => {
            setExpanded(e);
            persist('branchesExpanded', [...e]);
          }}
          selection={selection}
          onSelectionChange={(sel2, lead) => {
            setSelection(sel2);
            if (lead && sel2.size === 1) {
              if (settings.branchesSingleClickFilter) filterBy(lead);
              else if (settings.branchesSingleClickNavigate) navigate(lead);
            }
          }}
          onOpen={n => filterBy(n)}
          onKeyDown={(e, selected) => {
            const r = selected[0]?.data?.ref;
            if (e.key === 'Delete' && r) {
              send('branchAction', { id: 'delete', name: r.name, type: r.type, root: r.root });
              return true;
            }
            if (e.key === 'F2' && r?.type === 'local') {
              send('branchAction', { id: 'rename', name: r.name, type: r.type, root: r.root });
              return true;
            }
          }}
          onContextMenu={(e, selected) => {
            const r = selected[0]?.data?.ref;
            if (r && selected.length === 1) {
              showMenu([{ label: t('Update Branch Filter'), action: () => filterBy(selected[0]) }, { label: t('Navigate Log to Branch Head'), icon: 'general/locate', action: () => navigate(selected[0]) }, { separator: true }, ...refActions(r, current)], anchorAt(e));
            } else if (selected.length > 1) {
              const refs = selected.map(n => n.data?.ref).filter((x): x is Ref => !!x);
              const withHead = selected.some(n => n.key === 'head');
              const sameRoot = new Set(refs.map(x => x.root ?? store.root)).size <= 1;
              const pair = !sameRoot ? undefined : withHead && refs.length === 1 ? { ref: refs[0].name, with: current ?? 'HEAD' } : refs.length === 2 ? { ref: refs[0].name, with: refs[1].name } : undefined;
              const pairRoot = refs[0]?.root ?? store.root;
              showMenu(
                [
                  { label: t('Update Branch Filter'), action: () => void store.setFilters({ ...store.filters, branches: refs.map(x => x.name) }) },
                  { separator: true },
                  { label: t('Compare Branches'), disabled: !pair, action: () => pair && send('command', { id: 'ideagittool.compareRefs', args: { root: pairRoot, ...pair } }) },
                  { label: t('Show Files Diff'), disabled: !pair, action: () => pair && send('command', { id: 'ideagittool.compareRefs.files', args: { root: pairRoot, ...pair } }) },
                  { label: t('Update Selected'), icon: 'vcs/update', disabled: !refs.some(x => x.type === 'local'), action: () => refs.filter(x => x.type === 'local').forEach(x => send('branchAction', { id: 'update', name: x.name, type: x.type, root: x.root })) },
                  { label: t('Delete Branches'), icon: 'general/delete', action: () => refs.filter(x => !x.current).forEach(x => send('branchAction', { id: 'delete', name: x.name, type: x.type, root: x.root })) },
                ],
                anchorAt(e),
              );
            } else if (selected[0]?.key === 'remote') {
              showMenu([{ label: t('Manage Remotes…'), action: () => send('command', { id: 'ideagittool.remotes', args: { root: store.root } }) }], anchorAt(e));
            } else if (selected[0]?.data?.remote) {
              const root = selected[0].data.root ?? store.root;
              showMenu(
                [
                  { label: t('Update Branch Filter'), action: () => filterBy(selected[0]) },
                  { separator: true },
                  { label: t('Edit Remote…'), action: () => send('command', { id: 'ideagittool.remotes', args: { root } }) },
                  { label: t('Remove Remote'), action: () => send('command', { id: 'ideagittool.remotes', args: { root } }) },
                ],
                anchorAt(e),
              );
            } else if (selected[0]?.key === 'head') {
              showMenu([{ label: t('Update Branch Filter'), action: () => filterBy(selected[0]) }, { label: t('New Branch…'), action: () => send('command', { id: 'ideagittool.createBranch', args: { root: store.root } }) }], anchorAt(e));
            }
          }}
        />
      </div>
    </div>
  );
}

function findNode(nodes: Node[], key: string): Node | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.children) {
      const f = findNode(n.children, key);
      if (f) return f;
    }
  }
  return undefined;
}
