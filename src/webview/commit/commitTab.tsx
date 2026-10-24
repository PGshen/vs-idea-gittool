import { useEffect, useMemo, useState } from 'preact/hooks';
import { ActionButton, Separator, Split, Toolbar, Tree, TreeNode } from '../lib/components';
import { anchorAt, MenuEntry, showMenu } from '../lib/menu';
import { t } from '../lib/l10n';
import { call, persist, persisted, send } from '../lib/rpc';
import { changeKey, CommitRepoInfo, CommitViewState } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { allGroupKeys, countText, filesOfNodes, groupFiles, makeCheckState, NodeData } from './changesTree';
import { CommitPanel } from './commitPanel';

const keysOf = (changes: Change[]) => changes.map(changeKey);

export function operationText(r: CommitRepoInfo, multi: boolean): string {
  const where = (text: string) => (multi ? t('{0} in {1}', text, r.name) : text);
  const head = r.rebaseHeadName;
  const target = r.operationTarget;
  switch (r.operation) {
    case 'rebase':
      return where(
        head && target ? t('Rebasing {0} onto {1}', head, target) : head ? t('Rebasing {0}', head) : target ? t('Rebasing onto {0}', target) : t('Rebasing'),
      );
    case 'merge':
      return where(target ? t('Merging {0} into {1}', target, r.branch ?? 'HEAD') : t('Merging into {0}', r.branch ?? 'HEAD'));
    case 'cherry-pick':
      return where(target ? t('Cherry-picking {0}', target) : t('Cherry-picking'));
    case 'revert':
      return where(target ? t('Reverting {0}', target) : t('Reverting'));
    case 'am':
      return where(t('Applying patches'));
    case 'bisect':
      return where(t('Bisecting'));
    default:
      return '';
  }
}

/** "Continue …" / "Abort …" links of the operation banner. */
const OPERATION_ACTIONS: Record<string, { continue: string; abort: string }> = {
  rebase: { continue: t('Continue Rebase'), abort: t('Abort Rebase') },
  merge: { continue: t('Continue Merge'), abort: t('Abort Merge') },
  'cherry-pick': { continue: t('Continue Cherry-Pick'), abort: t('Abort Cherry-Pick') },
  revert: { continue: t('Continue Revert'), abort: t('Abort Revert') },
  am: { continue: t('Continue Apply'), abort: t('Abort Apply') },
  bisect: { continue: t('Continue Bisect'), abort: t('Abort Bisect') },
};

export function CommitTab({ state, visible }: { state: CommitViewState; visible: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(persisted<string[]>('expanded', [])));
  const [known, setKnown] = useState<Set<string>>(() => new Set(persisted<string[]>('knownGroups', [])));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [included, setIncluded] = useState<Set<string>>(new Set(state.included));
  useEffect(() => setIncluded(new Set(state.included)), [state.included]);

  const { settings, repos } = state;
  const multiRepo = repos.length > 1;
  const groupOpts = { groupByDirectory: settings.groupByDirectory, groupByRepository: settings.groupByRepository, repos };

  const nodes = useMemo(() => {
    const out: TreeNode<NodeData>[] = [];
    if (state.conflicts.length) {
      out.push({
        key: 'conflicts',
        label: t('Merge Conflicts'),
        text: t('Merge Conflicts'),
        hint: (
          <>
            {countText(state.conflicts.length)}
            <span class="conflict-link" onClick={e => (e.stopPropagation(), send('resolveConflicts', {}))}>
              {t('Resolve')}
            </span>
          </>
        ),
        labelClass: 'st-U',
        children: groupFiles(state.conflicts, 'conflicts/', { ...groupOpts, checkable: false }),
        data: { kind: 'conflicts' },
      });
    }
    const showLists = state.changelists.length > 1 || state.changelists.some(l => l.changes.length) || true;
    if (showLists) {
      for (const l of state.changelists) {
        out.push({
          key: `cl:${l.id}`,
          label: l.name,
          text: l.name,
          bold: l.isDefault && state.changelists.length > 1,
          hint: countText(l.changes.length),
          checkable: true,
          tip: l.comment || undefined,
          children: groupFiles(l.changes, `cl:${l.id}/`, { ...groupOpts, checkable: true }),
          data: { kind: 'changelist', id: l.id },
        });
      }
    }
    if (state.unversioned.length) {
      out.push({
        key: 'unversioned',
        label: t('Unversioned Files'),
        text: t('Unversioned Files'),
        hint: countText(state.unversioned.length),
        checkable: true,
        children: groupFiles(state.unversioned, 'unversioned/', { ...groupOpts, checkable: true }),
        data: { kind: 'unversioned' },
      });
    }
    if (state.ignored.length) {
      out.push({
        key: 'ignored',
        label: t('Ignored Files'),
        text: t('Ignored Files'),
        hint: countText(state.ignored.length),
        children: groupFiles(state.ignored, 'ignored/', { ...groupOpts, checkable: false }),
        data: { kind: 'ignored' },
      });
    }
    return out;
  }, [state, settings.groupByDirectory, settings.groupByRepository]);

  // Changelists and conflict nodes start expanded; directory nodes too.
  useEffect(() => {
    const next = new Set(expanded);
    const nextKnown = new Set(known);
    let changed = false;
    const visit = (list: TreeNode<NodeData>[]) => {
      for (const n of list) {
        if (!n.children) continue;
        if (!nextKnown.has(n.key)) {
          nextKnown.add(n.key);
          if (n.key !== 'unversioned' && n.key !== 'ignored') next.add(n.key);
          changed = true;
        }
        visit(n.children);
      }
    };
    visit(nodes);
    if (changed) {
      setExpanded(next);
      setKnown(nextKnown);
      persist('expanded', [...next]);
      persist('knownGroups', [...nextKnown].slice(-2000));
    }
  }, [nodes]);

  const checkState = useMemo(() => makeCheckState(included), [included, nodes]);

  const allNodes = useMemo(() => {
    const m = new Map<string, TreeNode<NodeData>>();
    const visit = (list: TreeNode<NodeData>[]) => list.forEach(n => (m.set(n.key, n), n.children && visit(n.children)));
    visit(nodes);
    return m;
  }, [nodes]);

  const selectedNodes = () => [...selection].map(k => allNodes.get(k)).filter((n): n is TreeNode<NodeData> => !!n);
  const selectedFiles = () => filesOfNodes(selectedNodes());
  const selectedChangelist = () => {
    const n = selectedNodes().find(x => x.data?.kind === 'changelist');
    if (n) return state.changelists.find(l => l.id === (n.data as { id: string }).id);
    const f = selectedFiles()[0];
    return f ? state.changelists.find(l => l.files.includes(changeKey(f))) : undefined;
  };

  const onCheck = (n: TreeNode<NodeData>, value: boolean) => {
    const keys = keysOf(filesOfNodes([n]));
    const next = new Set(included);
    keys.forEach(k => (value ? next.add(k) : next.delete(k)));
    setIncluded(next);
    send('setIncluded', { keys, value });
  };

  const showDiff = (files = selectedFiles()) => files.length && send('showDiff', { keys: keysOf(files) });
  const openSource = (files = selectedFiles()) => files.length && send('openSource', { keys: keysOf(files) });
  const rollback = () => send('rollback', { keys: keysOf(selectedFiles().filter(f => f.status !== '?')) });

  const contextMenu = (e: MouseEvent, sel: TreeNode<NodeData>[]) => {
    const files = filesOfNodes(sel);
    const keys = keysOf(files);
    const conflicts = files.filter(f => f.status === 'U');
    const unversioned = files.filter(f => f.status === '?');
    const tracked = files.filter(f => f.status !== '?' && f.status !== '!');
    const list = selectedChangelist();
    const listNode = sel.find(n => n.data?.kind === 'changelist');
    const single = files.length === 1 ? files[0] : undefined;
    const entries: MenuEntry[] = [];
    const inOperation = state.repos.some(r => r.operation !== 'none');
    const revertResolved: MenuEntry = { label: t('Revert Resolved'), icon: 'vcs/revert', disabled: !inOperation || !tracked.length, action: () => send('revertResolved', { keys: keysOf(tracked) }) };
    const rollbackFile: MenuEntry = { label: t('Rollback File…'), disabled: !tracked.length, action: () => send('rollback', { keys: keysOf(tracked) }) };
    const localHistory: MenuEntry = {
      label: t('Local History'),
      children: [
        { label: t('Show History…'), disabled: !single, action: () => send('localHistory', { key: changeKey(single!), action: 'show' }) },
        { label: t('Show History for Selection…'), disabled: true },
        { separator: true },
        { label: t('Show Project History…'), action: () => send('localHistory', { key: '', action: 'project' }) },
        { label: t('Recent Changes'), shortcut: 'Alt+Shift+C', action: () => send('localHistory', { key: '', action: 'recent' }) },
        { label: t('Put Label…'), action: () => send('localHistory', { key: '', action: 'label' }) },
      ],
    };
    if (conflicts.length) {
      entries.push(
        { label: t('Merge…'), icon: 'vcs/merge', disabled: conflicts.length !== 1, action: () => send('mergeConflict', { key: changeKey(conflicts[0]) }) },
        { label: t('Accept Theirs'), action: () => send('acceptTheirs', { keys: keysOf(conflicts) }) },
        { label: t('Accept Yours'), action: () => send('acceptYours', { keys: keysOf(conflicts) }) },
        { separator: true },
      );
    }
    entries.push(
      revertResolved,
      { label: files.length > 1 ? t('Commit Files…') : t('Commit File…'), disabled: !files.length, action: () => commitSelected(files) },
      { label: t('Rollback…'), icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z', disabled: !tracked.length, action: () => send('rollback', { keys: keysOf(tracked) }) },
      rollbackFile,
      { label: t('Move to Another Changelist…'), shortcut: 'Alt+Shift+M', disabled: !tracked.length, action: () => send('moveToChangelist', { keys: keysOf(tracked) }) },
      { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: !files.length, action: () => showDiff(files) },
      { label: t('Jump to Source'), shortcut: 'F4', disabled: !files.some(f => f.status !== 'D'), action: () => openSource(files) },
      {
        label: t('Copy Path/Reference…'),
        disabled: !files.length,
        children: [
          { label: t('Absolute Path'), shortcut: 'Ctrl+Shift+C', action: () => send('copyPath', { keys, kind: 'absolute' }) },
          { label: t('File Name'), action: () => send('copyPath', { keys, kind: 'name' }) },
          { separator: true },
          { label: t('Path with Line Number'), action: () => send('copyPath', { keys, kind: 'lineNumber' }) },
          { label: t('Path from Content Root'), action: () => send('copyPath', { keys, kind: 'contentRoot' }) },
          { label: t('Path From Repository Root'), action: () => send('copyPath', { keys, kind: 'repo' }) },
          { separator: true },
          { label: t('Copy Reference'), shortcut: 'Ctrl+Alt+Shift+C', action: () => send('copyPath', { keys, kind: 'reference' }) },
        ],
      },
      { separator: true },
      { label: t('Delete'), shortcut: 'Delete', disabled: !files.some(f => f.status !== 'D'), action: () => send('deleteFiles', { keys }) },
      { label: t('Add to VCS'), shortcut: 'Ctrl+Alt+A', disabled: !unversioned.length, action: () => send('addToVcs', { keys: keysOf(unversioned) }) },
      { label: t('Add to .gitignore'), disabled: !unversioned.length, action: () => send('ignore', { keys: keysOf(unversioned) }) },
      { label: t('Remove from VCS'), icon: 'general/remove', disabled: !tracked.length, action: () => send('removeFromVcs', { keys: keysOf(tracked) }) },
      { separator: true },
      { label: t('New Changelist…'), icon: 'general/add', action: () => send('newChangelist', { keys: keysOf(tracked) }) },
      {
        label: t('Delete Changelist'),
        icon: 'general/remove',
        disabled: !listNode || state.changelists.length <= 1,
        action: () => list && send('removeChangelist', { id: list.id }),
      },
      { label: t('Set Active Changelist'), icon: 'actions/selectAll', shortcut: 'Ctrl+Space', disabled: !list || list.isDefault, action: () => list && send('setActiveChangelist', { id: list.id }) },
      { label: t('Edit Changelist…'), icon: 'general/edit', shortcut: 'F2', disabled: !listNode, action: () => list && send('editChangelist', { id: list.id }) },
      { label: t('Create Patch from Local Changes…'), icon: 'vcs/patch', disabled: !files.length, action: () => send('createPatch', { keys }) },
      { label: t('Copy as Patch to Clipboard'), disabled: !files.length, action: () => send('copyPatch', { keys }) },
      { label: t('Shelve Changes…'), icon: 'vcsimpl/stash', disabled: !files.length, action: () => send('shelve', { keys }) },
      { separator: true },
      { label: t('Refresh'), icon: 'general/refresh', action: () => send('refresh') },
      { separator: true },
      localHistory,
      {
        label: 'Git',
        children: [
          { label: files.length > 1 ? t('Commit Files…') : t('Commit File…'), disabled: !files.length, action: () => commitSelected(files) },
          { label: t('Add'), icon: 'general/add', shortcut: 'Ctrl+Alt+A', disabled: !unversioned.length, action: () => send('addToVcs', { keys: keysOf(unversioned) }) },
          { label: t('Add to .gitignore'), disabled: !unversioned.length, action: () => send('ignore', { keys: keysOf(unversioned) }) },
          { separator: true },
          { label: t('Annotate with Git Blame'), disabled: !single || single.status === '?' || single.status === 'A', action: () => send('annotate', { key: changeKey(single!) }) },
          { label: t('Compare with Same Repository Version'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: !single, action: () => showDiff([single!]) },
          {
            label: t('Compare with Revision…'),
            disabled: !single || single.status === '?',
            action: () => send('gitCommand', { command: 'ideagittool.compareWithRevision', args: fileUriArg(single!) }),
          },
          {
            label: t('Compare with Branch or Tag…'),
            disabled: !single || single.status === '?',
            action: () => send('gitCommand', { command: 'ideagittool.compareWithBranch', args: fileUriArg(single!) }),
          },
          { label: t('Show History'), icon: 'general/history', disabled: !single || single.status === '?', action: () => send('showHistory', { key: changeKey(single!) }) },
          { separator: true },
          { label: t('Rollback…'), icon: 'vcs/revert', shortcut: 'Ctrl+Alt+Z', disabled: !tracked.length, action: () => send('rollback', { keys: keysOf(tracked) }) },
          rollbackFile,
          { separator: true },
          { label: t('Resolve Conflicts…'), disabled: !state.conflicts.length, action: () => send('resolveConflicts', {}) },
          revertResolved,
        ],
      },
    );
    // Like IntelliJ popups, actions that are not applicable are hidden.
    showMenu(hideDisabled(entries), anchorAt(e));
  };

  const [commitTrigger, setCommitTrigger] = useState(0);
  const commitSelected = (files: Change[]) => {
    const keys = keysOf(files.filter(f => f.status !== 'U' && f.status !== '!'));
    setIncluded(new Set(keys));
    send('setIncludedExactly', { keys });
    setCommitTrigger(x => x + 1);
  };

  const onKeyDown = (e: KeyboardEvent, sel: TreeNode<NodeData>[]) => {
    const files = filesOfNodes(sel);
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'd') return void showDiff(files), true;
    if (e.key === 'F4') return void openSource(files), true;
    if (e.key === 'Enter') {
      if (sel.length === 1 && sel[0].children) return false;
      if (settings.doubleClick === 'source') openSource(files);
      else showDiff(files);
      return true;
    }
    if (e.key === 'Delete') return void send('deleteFiles', { keys: keysOf(files) }), true;
    if (ctrl && e.altKey && e.key.toLowerCase() === 'z') return void rollback(), true;
    if (ctrl && e.altKey && e.key.toLowerCase() === 'a') return void send('addToVcs', { keys: keysOf(files.filter(f => f.status === '?')) }), true;
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'm') return void send('moveToChangelist', { keys: keysOf(files) }), true;
    if (e.key === 'F2') {
      const l = selectedChangelist();
      if (l) send('editChangelist', { id: l.id });
      return true;
    }
    if (ctrl && e.key === ' ') {
      const l = selectedChangelist();
      if (l) send('setActiveChangelist', { id: l.id });
      return true;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'h') return void send('shelveSilently', { keys: keysOf(files) }), true;
    return false;
  };

  const viewOptions = (): MenuEntry[] => [
    { separator: true, label: t('Group By') },
    { label: t('Directory'), shortcut: 'Ctrl+Alt+P', checked: settings.groupByDirectory, action: () => send('setSettings', { groupByDirectory: !settings.groupByDirectory }) },
    ...(multiRepo ? [{ label: t('Repository'), checked: settings.groupByRepository, action: () => send('setSettings', { groupByRepository: !settings.groupByRepository }) }] : []),
    { separator: true, label: t('Show') },
    { label: t('Ignored Files'), icon: settings.showIgnored ? undefined : 'actions/toggleVisibility', checked: settings.showIgnored, action: () => send('setSettings', { showIgnored: !settings.showIgnored }) },
  ];

  const changelistMenu = (): MenuEntry[] => {
    const list = selectedChangelist();
    const tracked = selectedFiles().filter(f => f.status !== '?' && f.status !== '!' && f.status !== 'U');
    const listSelected = selectedNodes().some(n => n.data?.kind === 'changelist');
    return [
      { label: t('New Changelist…'), icon: 'general/add', action: () => send('newChangelist', { keys: keysOf(tracked) }) },
      { label: t('Edit Changelist…'), icon: 'general/edit', shortcut: 'F2', disabled: !list, action: () => list && send('editChangelist', { id: list.id }) },
      { label: t('Delete Changelist'), icon: 'general/remove', disabled: !listSelected || state.changelists.length <= 1, action: () => list && send('removeChangelist', { id: list.id }) },
      { label: t('Set Active Changelist'), icon: 'actions/selectAll', shortcut: 'Ctrl+Space', disabled: !list || list.isDefault, action: () => list && send('setActiveChangelist', { id: list.id }) },
      { label: t('Move to Another Changelist…'), shortcut: 'Alt+Shift+M', disabled: !tracked.length, action: () => send('moveToChangelist', { keys: keysOf(tracked) }) },
    ];
  };

  const ops = repos.filter(r => r.operation !== 'none');

  return (
    <>
      <Toolbar class="changes-toolbar">
        <ActionButton icon="general/refresh" tip={t('Refresh')} onClick={() => send('refresh')} />
        <ActionButton icon="vcs/revert" tip={t('Rollback…')} shortcut="Ctrl+Alt+Z" onClick={rollback} />
        <ActionButton icon="vcs/diff" tip={t('Show Diff')} shortcut="Ctrl+D" disabled={!selectedFiles().length} onClick={() => showDiff()} />
        <ActionButton icon="vcs/changelist" tip={t('Changelists')} menu={changelistMenu} />
        <ActionButton icon="vcs/shelve" tip={t('Shelve Silently')} shortcut="Ctrl+Shift+H" onClick={() => send('shelveSilently', { keys: keysOf(selectedFiles()) })} />
        <ActionButton icon="general/show" tip={t('View Options')} menu={viewOptions} />
        <Separator />
        <ActionButton icon="general/locate" tip={t('Select Opened File in Changes View')} onClick={() => selectOpened()} />
        <ActionButton
          icon="general/expandAll"
          tip={t('Expand All')}
          shortcut="Ctrl+="
          onClick={() => {
            const next = new Set([...expanded, ...allGroupKeys(nodes)]);
            setExpanded(next);
            persist('expanded', [...next]);
          }}
        />
        <ActionButton
          icon="general/collapseAll"
          tip={t('Collapse All')}
          shortcut="Ctrl+-"
          onClick={() => {
            setExpanded(new Set());
            persist('expanded', []);
          }}
        />
      </Toolbar>
      {ops.map(r => (
        <div class="banner operation-banner" key={r.root}>
          <span>{operationText(r, multiRepo)}</span>
          <span class="spacer" />
          {state.conflicts.some(c => c.root === r.root) ? (
            <span class="link" onClick={() => send('resolveConflicts', { root: r.root })}>
              {t('Resolve…')}
            </span>
          ) : (
            r.operation !== 'bisect' && (
              <span class="link" onClick={() => send('operation', { action: 'continue', root: r.root })}>
                {OPERATION_ACTIONS[r.operation]?.continue}
              </span>
            )
          )}
          {(r.operation === 'rebase' || r.operation === 'cherry-pick' || r.operation === 'revert') && (
            <span class="link" onClick={() => send('operation', { action: 'skip', root: r.root })}>
              {t('Skip Commit')}
            </span>
          )}
          <span class="link" onClick={() => send('operation', { action: 'abort', root: r.root })}>
            {OPERATION_ACTIONS[r.operation]?.abort}
          </span>
        </div>
      ))}
      {state.conflicts.length > 0 && ops.length === 0 && (
        <div class="banner warning">
          <span>{t('Cannot proceed due to merge conflicts')}</span>
          <span class="spacer" />
          <span class="link" onClick={() => send('resolveConflicts', {})}>
            {t('Resolve…')}
          </span>
        </div>
      )}
      <Split vertical persistKey="commit-panel" initial={290} second min={120}>
        <Tree<NodeData>
          class="changes-tree"
          nodes={nodes}
          expanded={expanded}
          onExpandedChange={e => {
            setExpanded(e);
            persist('expanded', [...e]);
          }}
          selection={selection}
          onSelectionChange={setSelection}
          checkState={checkState}
          onCheck={onCheck}
          onOpen={n => {
            if (n.data?.kind !== 'file') return;
            if (settings.doubleClick === 'source') openSource([n.data.change]);
            else showDiff([n.data.change]);
          }}
          onContextMenu={contextMenu}
          onKeyDown={onKeyDown}
          draggable
          onDrop={(target, keys) => {
            const listNode = target.data?.kind === 'changelist' ? target : undefined;
            const id = listNode ? (listNode.data as { id: string }).id : state.changelists.find(l => target.data?.kind === 'file' && l.files.includes(changeKey(target.data.change)))?.id;
            if (!id) return;
            const files = filesOfNodes(keys.map(k => allNodes.get(k)).filter((n): n is TreeNode<NodeData> => !!n)).filter(f => f.status !== '?');
            if (files.length) send('moveToChangelist', { keys: keysOf(files), listId: id });
          }}
          emptyText={
            <>
              <div>{t('No changes')}</div>
              <div class="secondary" style={{ marginTop: '4px' }}>
                {t('Modified files will appear here')}
              </div>
            </>
          }
        />
        <CommitPanel state={state} included={included} commitTrigger={commitTrigger} visible={visible} />
      </Split>
    </>
  );

  function selectOpened() {
    call<string | undefined>('activeFileKey').then(k => {
      if (!k || !allNodes.has(k)) return;
      setSelection(new Set([k]));
    });
  }
}

function hideDisabled(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter(e => e.separator || !e.disabled).map(e => (!e.separator && e.children ? { ...e, children: hideDisabled(e.children) } : e));
}

function fileUriArg(c: Change) {
  return { $uri: `${c.root}/${c.path}` };
}
