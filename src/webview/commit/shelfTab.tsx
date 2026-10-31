import { useMemo, useState } from 'preact/hooks';
import { ActionButton, Toolbar, Tree, TreeNode } from '../lib/components';
import { shortcutKey } from '../lib/keys';
import { anchorAt, MenuEntry, showMenu } from '../lib/menu';
import { t } from '../lib/l10n';
import { persist, persisted, send } from '../lib/rpc';
import { CommitViewState, ShelfInfo } from '../../shared/commitProtocol';
import { allGroupKeys, countText, groupFiles, NodeData } from './changesTree';
import { formatDate } from './format';

interface ShelfNodeData {
  kind: 'shelf' | 'recycled' | 'file' | 'dir' | 'repo';
  id?: string;
}

/** The Shelf tab: shelved changelists, their files, and "Recently Deleted". */
export function ShelfTab({ state }: { state: CommitViewState }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(persisted<string[]>('shelfExpanded', ['recycled'])));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const { settings } = state;

  const nodes = useMemo(() => {
    const make = (s: ShelfInfo): TreeNode<NodeData> => ({
      key: `shelf:${s.id}`,
      label: s.name,
      text: s.name,
      icon: 'vcs/changelist',
      hint: formatDate(s.date),
      tip: `${countText(s.files.length)}`,
      data: { kind: 'shelf', id: s.id },
      children: groupFiles(s.files, `shelf:${s.id}/`, {
        groupByDirectory: settings.groupByDirectory,
        groupByRepository: false,
        repos: state.repos,
        checkable: false,
        fileKey: c => `shelf:${s.id}\u0000${c.path}`,
      }),
    });
    const active = state.shelves.filter(s => !s.deleted).map(make);
    const deleted = state.shelves.filter(s => s.deleted);
    if (deleted.length && settings.showRecycledShelves) {
      active.push({
        key: 'recycled',
        label: t('Recently Deleted'),
        text: t('Recently Deleted'),
        hint: deleted.length === 1 ? t('1 changelist') : t('{0} changelists', deleted.length),
        data: { kind: 'recycled' },
        children: deleted.map(make),
      });
    }
    return active;
  }, [state.shelves, settings.groupByDirectory, settings.showRecycledShelves]);

  const byKey = useMemo(() => {
    const m = new Map<string, TreeNode<NodeData>>();
    const visit = (l: TreeNode<NodeData>[], shelfId?: string) =>
      l.forEach(n => {
        const id = n.data?.kind === 'shelf' ? (n.data as { id: string }).id : shelfId;
        (n as TreeNode<NodeData> & { shelfId?: string }).shelfId = id;
        m.set(n.key, n);
        if (n.children) visit(n.children, id);
      });
    visit(nodes);
    return m;
  }, [nodes]);

  /** Selected shelves and files grouped by shelf. */
  const selected = (sel?: TreeNode<NodeData>[]) => {
    const list = sel ?? [...selection].map(k => byKey.get(k)).filter((n): n is TreeNode<NodeData> => !!n);
    const shelves = new Set<string>();
    const files = new Map<string, string[]>();
    const collect = (n: TreeNode<NodeData>) => {
      const id = (n as TreeNode<NodeData> & { shelfId?: string }).shelfId;
      if (n.data?.kind === 'shelf') shelves.add(id!);
      else if (n.data?.kind === 'file' && id) files.set(id, [...(files.get(id) ?? []), n.data.change.path]);
      else if (n.data?.kind === 'recycled') n.children?.forEach(collect);
      else n.children?.forEach(collect);
    };
    list.forEach(collect);
    return { shelves: [...shelves], files };
  };

  const firstFile = (sel?: TreeNode<NodeData>[]) => {
    const { files, shelves } = selected(sel);
    for (const [id, paths] of files) return { id, path: paths[0] };
    const s = state.shelves.find(x => x.id === shelves[0]);
    return s?.files[0] ? { id: s.id, path: s.files[0].path } : undefined;
  };

  const showDiff = (sel?: TreeNode<NodeData>[]) => {
    const f = firstFile(sel);
    if (f) send('shelfDiff', f);
  };

  const unshelveSilently = (sel?: TreeNode<NodeData>[]) => {
    const { shelves, files } = selected(sel);
    if (shelves.length) send('unshelveSilently', { ids: shelves });
    for (const [id, paths] of files) if (!shelves.includes(id)) send('unshelveSilently', { ids: [id], paths });
  };

  const del = (sel?: TreeNode<NodeData>[]) => {
    const { shelves, files } = selected(sel);
    if (shelves.length) send('deleteShelves', { ids: shelves });
    for (const [id, paths] of files) if (!shelves.includes(id)) send('deleteShelfFiles', { id, paths });
  };

  const contextMenu = (e: MouseEvent, sel: TreeNode<NodeData>[]) => {
    const { shelves, files } = selected(sel);
    const ids = [...new Set([...shelves, ...files.keys()])];
    const one = ids.length === 1 ? ids[0] : undefined;
    const isDeleted = ids.some(id => state.shelves.find(s => s.id === id)?.deleted);
    const paths = one && !shelves.length ? files.get(one) : undefined;
    const f = firstFile(sel);
    const entries: MenuEntry[] = [
      { label: t('Unshelve…'), icon: 'vcs/unshelve', shortcut: 'Ctrl+Shift+U', disabled: !one, action: () => send('unshelve', { id: one, paths }) },
      { label: t('Unshelve Silently'), icon: 'vcs/unshelve', shortcut: 'Ctrl+Alt+U', disabled: !ids.length, action: () => unshelveSilently(sel) },
      ...(isDeleted ? [{ label: t('Restore'), action: () => send('restoreShelves', { ids }) }] : []),
      { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: !f, action: () => showDiff(sel) },
      { label: t('Compare with Local'), disabled: !f, action: () => f && send('shelfCompareWithLocal', f) },
      { label: t('Create Patch…'), icon: 'vcs/patch', disabled: !one, action: () => send('shelfCreatePatch', { id: one, paths }) },
      { label: t('Copy as Patch to Clipboard'), disabled: !one, action: () => send('shelfCopyPatch', { id: one, paths }) },
      { label: t('Import Patches…'), action: () => send('importPatches') },
      { separator: true },
      { label: t('Rename…'), shortcut: 'F2', disabled: !one || !!paths, action: () => send('renameShelf', { id: one }) },
      { label: t('Delete'), shortcut: 'Delete', disabled: !ids.length, action: () => del(sel) },
      { separator: true },
      { label: t('Clean Already Unshelved…'), disabled: !state.shelves.some(s => s.deleted), action: () => send('cleanShelves') },
    ];
    showMenu(entries, anchorAt(e));
  };

  const onKeyDown = (e: KeyboardEvent, sel: TreeNode<NodeData>[]) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'd') return void showDiff(sel), true;
    if (e.key === 'Delete') return void del(sel), true;
    if (ctrl && e.altKey && shortcutKey(e) === 'u') return void unshelveSilently(sel), true;
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'u') {
      const { shelves, files } = selected(sel);
      const id = shelves[0] ?? [...files.keys()][0];
      if (id) send('unshelve', { id, paths: shelves.length ? undefined : files.get(id) });
      return true;
    }
    if (e.key === 'F2') {
      const { shelves } = selected(sel);
      if (shelves.length === 1) send('renameShelf', { id: shelves[0] });
      return true;
    }
    return false;
  };

  const viewOptions = (): MenuEntry[] => [
    { separator: true, label: t('Group By') },
    { label: t('Directory'), shortcut: 'Ctrl+Alt+P', checked: settings.groupByDirectory, action: () => send('setSettings', { groupByDirectory: !settings.groupByDirectory }) },
    { separator: true, label: t('Show') },
    { label: t('Already Unshelved'), checked: settings.showRecycledShelves, action: () => send('setSettings', { showRecycledShelves: !settings.showRecycledShelves }) },
  ];

  return (
    <>
      <Toolbar class="changes-toolbar">
        <ActionButton icon="vcs/unshelve" tip={t('Unshelve Silently')} shortcut="Ctrl+Alt+U" disabled={!selection.size} onClick={() => unshelveSilently()} />
        <ActionButton icon="vcs/diff" tip={t('Show Diff')} shortcut="Ctrl+D" disabled={!selection.size} onClick={() => showDiff()} />
        <ActionButton icon="general/show" tip={t('View Options')} menu={viewOptions} />
        <ActionButton
          icon="general/expandAll"
          tip={t('Expand All')}
          onClick={() => {
            const next = new Set([...expanded, ...allGroupKeys(nodes)]);
            setExpanded(next);
            persist('shelfExpanded', [...next]);
          }}
        />
        <ActionButton
          icon="general/collapseAll"
          tip={t('Collapse All')}
          onClick={() => {
            setExpanded(new Set());
            persist('shelfExpanded', []);
          }}
        />
      </Toolbar>
      <Tree<NodeData>
        class="changes-tree"
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={e => {
          setExpanded(e);
          persist('shelfExpanded', [...e]);
        }}
        selection={selection}
        onSelectionChange={setSelection}
        onOpen={n => n.data?.kind === 'file' && showDiff([n])}
        onContextMenu={contextMenu}
        onKeyDown={onKeyDown}
        emptyText={
          <>
            <div>{t('No shelved changes')}</div>
            <div class="secondary" style={{ marginTop: '4px' }}>
              {t('Use Shelve Changes in the Commit tab to put changes aside')}
            </div>
          </>
        }
      />
    </>
  );
}
