import { useEffect, useMemo, useState } from 'preact/hooks';
import { Button, Split, Tree, TreeNode } from '../lib/components';
import { anchorAt, MenuEntry, showMenu } from '../lib/menu';
import { t } from '../lib/l10n';
import { call, send } from '../lib/rpc';
import { CommitViewState, StashInfo } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { allGroupKeys, groupFiles, NodeData } from './changesTree';
import { formatDate } from './format';

interface StashFile extends Change {
  left: string;
  right: string;
}

const stashKey = (s: StashInfo) => `stash:${s.root}\u0000${s.hash}`;

/**
 * The Stash tab (SavedPatchesUi with the git stash provider): the list of stashes on top,
 * the changes of the selected stash below, and Apply / Pop buttons.
 */
export function StashTab({ state }: { state: CommitViewState }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(state.repos.map(r => `repo:${r.root}`)));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [fileExpanded, setFileExpanded] = useState<Set<string>>(new Set());
  const [fileSelection, setFileSelection] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<StashFile[] | undefined>();
  const multi = state.repos.length > 1;

  const stashOf = (k: string) => state.stashes.find(s => stashKey(s) === k);
  const selectedStash = [...selection].map(stashOf).find(Boolean) ?? (selection.size === 0 ? state.stashes[0] : undefined);

  useEffect(() => {
    setFiles(undefined);
    if (!selectedStash) return;
    let cancelled = false;
    call<StashFile[]>('stashFiles', { root: selectedStash.root, hash: selectedStash.hash }).then(list => {
      if (cancelled) return;
      setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedStash?.hash]);

  const nodes = useMemo(() => {
    const make = (s: StashInfo): TreeNode<NodeData> => ({
      key: stashKey(s),
      label: s.message,
      text: s.message,
      prefix: <span class="secondary stash-ref">{s.ref.replace(/^stash@\{(\d+)\}$/, '$1')}</span>,
      hint: `${s.branch ?? ''}`,
      tip: s.branch ? t('{0} created on {1} at {2}', s.ref, s.branch, formatDate(s.date)) : t('{0} created on detached HEAD at {1}', s.ref, formatDate(s.date)),
      data: { kind: 'stash', id: s.ref, root: s.root },
    });
    if (!multi) return state.stashes.map(make);
    return state.repos
      .filter(r => state.stashes.some(s => s.root === r.root))
      .map(r => ({
        key: `repo:${r.root}`,
        label: r.name,
        text: r.name,
        icon: 'nodes/folder',
        data: { kind: 'repo', root: r.root } as NodeData,
        children: state.stashes.filter(s => s.root === r.root).map(make),
      }));
  }, [state.stashes]);

  const fileNodes = useMemo(
    () =>
      files && selectedStash
        ? groupFiles(files, 'f/', { groupByDirectory: state.settings.groupByDirectory, groupByRepository: false, repos: state.repos, checkable: false, fileKey: c => `f/${c.path}` })
        : [],
    [files, state.settings.groupByDirectory],
  );
  useEffect(() => setFileExpanded(new Set(allGroupKeys(fileNodes))), [fileNodes]);

  const stashMenu = (s: StashInfo | undefined): MenuEntry[] => [
    { label: t('Pop'), disabled: !s, action: () => s && send('stashApply', { root: s.root, ref: s.ref, pop: true }) },
    { label: t('Apply'), disabled: !s, action: () => s && send('stashApply', { root: s.root, ref: s.ref, pop: false }) },
    { label: t('Unstash…'), disabled: !s, action: () => s && send('unstashAs', { root: s.root, ref: s.ref }) },
    { label: t('Drop'), disabled: !s, action: () => s && send('stashDrop', { root: s.root, ref: s.ref, message: s.message }) },
    { label: multi && s ? t('Clear Stashes in {0}', String(state.repos.find(r => r.root === s.root)?.name)) : t('Clear'), disabled: !s, action: () => s && send('stashClear', { root: s.root }) },
    { separator: true },
    { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: !files?.length, action: () => files?.[0] && send('stashDiff', { file: files[0] }) },
    { label: t('Compare with Local'), disabled: !files?.length, action: () => files?.[0] && send('stashDiff', { file: files[0], withLocal: 'after' }) },
  ];

  const selectedFile = (sel?: TreeNode<NodeData>[]) => {
    const list = sel ?? fileNodes;
    for (const n of list) if (n.data?.kind === 'file' && (sel || fileSelection.has(n.key))) return n.data.change as StashFile;
    return undefined;
  };

  const fileMenu = (e: MouseEvent, sel: TreeNode<NodeData>[]) => {
    const f = selectedFile(sel);
    showMenu(
      [
        { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: !f, action: () => send('stashDiff', { file: f }) },
        { label: t('Compare with Local'), disabled: !f, action: () => send('stashDiff', { file: f, withLocal: 'after' }) },
        { label: t('Compare Before with Local'), disabled: !f, action: () => send('stashDiff', { file: f, withLocal: 'before' }) },
        { label: t('Edit Source'), icon: 'general/edit', shortcut: 'F4', disabled: !f, action: () => f && send('gitCommand', { command: 'vscode.open', args: { $uri: `${f.root}/${f.path}` } }) },
      ],
      anchorAt(e),
    );
  };

  if (!state.stashes.length) {
    return (
      <div class="empty-text">
        {t('No stashes or shelves added.')}
        <br />
        <span class="link" onClick={() => send('stashChanges')}>
          {t('Stash Changes…')}
        </span>
      </div>
    );
  }

  return (
    <Split vertical persistKey="stash-split" initial={180} min={60}>
      <Tree<NodeData>
        class="changes-tree"
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={setExpanded}
        selection={selectedStash && selection.size === 0 ? new Set([stashKey(selectedStash)]) : selection}
        onSelectionChange={setSelection}
        onOpen={n => n.data?.kind === 'stash' && files?.[0] && send('stashDiff', { file: files[0] })}
        onContextMenu={(e, sel) => showMenu(stashMenu(sel.map(n => stashOf(n.key)).find(Boolean)), anchorAt(e))}
        onKeyDown={(e, sel) => {
          const s = sel.map(n => stashOf(n.key)).find(Boolean);
          if (e.key === 'Delete' && s) return void send('stashDrop', { root: s.root, ref: s.ref, message: s.message }), true;
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && s) return void send('stashApply', { root: s.root, ref: s.ref, pop: false }), true;
          return false;
        }}
      />
      <div class="stash-changes">
        <Tree<NodeData>
          class="changes-tree"
          nodes={fileNodes}
          expanded={fileExpanded}
          onExpandedChange={setFileExpanded}
          selection={fileSelection}
          onSelectionChange={setFileSelection}
          onOpen={n => n.data?.kind === 'file' && send('stashDiff', { file: n.data.change })}
          onContextMenu={fileMenu}
          onKeyDown={(e, sel) => {
            const f = selectedFile(sel);
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && f) return void send('stashDiff', { file: f }), true;
            return false;
          }}
          emptyText={files ? t('No changes') : <span class="spinner" style={{ display: 'inline-block' }} />}
        />
        <div class="stash-buttons" data-tip={t('Apply — apply and keep the stash in the list. Pop — apply and remove the stash from the list.')}>
          <Button disabled={!selectedStash} onClick={() => selectedStash && send('stashApply', { root: selectedStash.root, ref: selectedStash.ref, pop: false })}>
            {t('Apply')}
          </Button>
          <Button disabled={!selectedStash} onClick={() => selectedStash && send('stashApply', { root: selectedStash.root, ref: selectedStash.ref, pop: true })}>
            {t('Pop')}
          </Button>
        </div>
      </div>
    </Split>
  );
}
