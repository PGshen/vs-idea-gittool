import type { ContextInfo } from '../../shared/logProtocol';
import type { Change, Ref } from '../../shared/types';
import { Anchor, MenuEntry, showMenu } from '../lib/menu';
import { t } from '../lib/l10n';
import { call, send } from '../lib/rpc';
import { store } from './store';
import { goToRelative } from './table';

export function runCommitAction(id: string, arg?: string) {
  const hashes = store.selectedRows().map(r => r.h);
  if (!hashes.length) return;
  send('commitAction', { id, hashes, arg });
}

const short = (h: string) => h.slice(0, 8);

/** Vcs.Log.ContextMenu + Git.Log.ContextMenu. */
export async function commitMenu(anchor: Anchor) {
  const rows = store.selectedRows();
  if (!rows.length) return;
  const hashes = rows.map(r => r.h);
  const info = await call<ContextInfo>('contextInfo', hashes);
  const one = rows.length === 1;
  const current = store.currentBranch;
  const editable = info.inHead && info.operation === 'none';
  const noMergesEditable = editable && !info.hasMerges;
  const a = (id: string, arg?: string) => () => runCommitAction(id, arg);

  const checkout: MenuEntry[] = [];
  if (one) {
    const branchRefs = info.refs.filter(r => r.type === 'local' || r.type === 'remote');
    for (const r of branchRefs) checkout.push({ label: r.name, icon: r.type === 'local' ? 'general/vcs' : undefined, disabled: r.current, action: a('checkoutBranch', r.name) });
    if (branchRefs.length) checkout.push({ separator: true });
    checkout.push({ label: t("Revision '{0}'", short(hashes[0])), action: a('checkoutRevision') });
  }
  const checkoutEntry: MenuEntry =
    checkout.length === 1 ? { label: t("Checkout Revision '{0}'", short(hashes[0])), action: a('checkoutRevision') } : { label: t('Checkout'), disabled: !one, children: checkout };

  const branchGroups: MenuEntry[] = info.refs
    .filter(r => r.type !== 'stash')
    .map(r => ({ label: r.type === 'tag' ? t("Tag '{0}'", r.name) : t("Branch '{0}'", r.name), children: refActions(r, current) }));

  const entries: MenuEntry[] = [
    { label: t('Copy Revision Number'), icon: 'general/copy', shortcut: 'Ctrl+C', action: a('copy') },
    { label: t('Create Patch…'), icon: 'vcs/patch', action: a('createPatch') },
    { label: t('Cherry-Pick'), icon: 'dvcs/cherryPick', disabled: info.operation !== 'none', action: a('cherryPick') },
    { separator: true },
    one ? checkoutEntry : { label: t('Checkout'), disabled: true },
    { label: t('Show Repository at Revision'), disabled: !one, action: a('showRepositoryAtRevision') },
    { label: t('Compare Versions'), icon: 'vcs/diff', disabled: rows.length !== 2, action: a('compareVersions') },
    { label: t('Compare with Local'), disabled: !one, action: a('compareWithLocal') },
    { separator: true },
    { label: t('Reset Current Branch to Here…'), icon: 'vcs/revert', disabled: !one || store.head.detached && !store.head.hash, action: a('reset') },
    { label: rows.length > 1 ? t('Revert Commits') : t('Revert Commit'), disabled: info.operation !== 'none', action: a('revert') },
    { label: t('Undo Commit…'), disabled: !editable || !noMergesEditable, action: a('undo') },
    { separator: true },
    { label: t('Edit Commit Message…'), shortcut: 'F2', disabled: !one || !editable, action: a('reword') },
    { label: t('Fixup…'), disabled: !one || !noMergesEditable, action: a('fixup') },
    { label: t('Squash Into…'), disabled: !one || !noMergesEditable, action: a('squashInto') },
    { label: rows.length > 1 ? t('Drop Commits') : t('Drop Commit'), disabled: !noMergesEditable, action: a('drop') },
    { label: t('Squash Commits…'), disabled: rows.length < 2 || !noMergesEditable, action: a('squash') },
    { label: t('Interactively Rebase from Here…'), disabled: !one || !noMergesEditable, action: a('interactiveRebase') },
    { label: t('Push All up to Here…'), disabled: !one || !info.inHead || store.head.detached, action: a('pushUpTo') },
    { label: t('Add Commits to Remote Branch…'), disabled: !info.hasRemoteBranches || info.hasMerges || !!info.mixedRoots || info.operation !== 'none', action: a('addToRemote') },
    { separator: true },
    ...branchGroups,
    { label: t('New Branch…'), disabled: !one, action: a('newBranch') },
    { label: t('New Tag…'), disabled: !one, action: a('newTag') },
    { separator: true },
    { label: t('Go to Child Commit'), shortcut: '←', disabled: !one, action: () => void goToRelative('child') },
    { label: t('Go to Parent Commit'), shortcut: '→', disabled: !one, action: () => void goToRelative('parent') },
  ];
  if (info.webUrl) {
    const host = /github/.test(info.webUrl) ? 'GitHub' : /gitlab/.test(info.webUrl) ? 'GitLab' : /bitbucket/.test(info.webUrl) ? 'Bitbucket' : 'Browser';
    entries.push({ separator: true }, { label: host === 'Browser' ? t('Open in Browser') : t('Open on {0}', host), icon: host === 'GitHub' ? 'vcs/github' : 'toolwindows/web', action: () => send('openUrl', info.webUrl) });
  }
  showMenu(store.init.mode === 'history' ? historyMenu(info, rows.length) : entries, anchor);
}

/** Vcs.FileHistory.ContextMenu */
function historyMenu(info: ContextInfo, count: number): MenuEntry[] {
  const one = count === 1;
  const a = (id: string) => () => runCommitAction(id);
  const editable = info.inHead && info.operation === 'none' && !info.hasMerges;
  const entries: MenuEntry[] = [
    { label: t('Copy Revision Number'), icon: 'general/copy', shortcut: 'Ctrl+C', action: a('copy') },
    { label: t('Create Patch…'), icon: 'vcs/patch', action: a('createPatch') },
    { label: t('Cherry-Pick'), icon: 'dvcs/cherryPick', disabled: info.operation !== 'none', action: a('cherryPick') },
    { separator: true },
    { label: t('Get'), icon: 'general/download', disabled: !one, action: a('historyGet') },
    { label: t('Show File at Revision'), disabled: !one, action: a('historyShowFile') },
    { label: t('Compare with Local'), disabled: !one, action: a('historyCompareWithLocal') },
    { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', action: a('historyDiff') },
    { label: t('Show All Affected Files'), icon: 'vcs/changes', shortcut: 'Alt+Shift+A', disabled: !one, action: a('showDiff') },
    { label: t('Annotate'), icon: 'general/listFiles', disabled: !one, action: a('historyAnnotate') },
    { label: t('Show in VCS Log'), icon: 'toolwindows/vcs', disabled: !one, action: a('showInLog') },
    { label: count > 1 ? t('Revert Commits') : t('Revert Commit'), disabled: info.operation !== 'none', action: a('revert') },
    { label: t('Fixup…'), disabled: !one || !editable, action: a('fixup') },
    { label: t('Squash Into…'), disabled: !one || !editable, action: a('squashInto') },
    { separator: true },
    { label: t('New Tag…'), disabled: !one, action: a('newTag') },
  ];
  if (info.webUrl) entries.push({ separator: true }, { label: t('Open on GitHub'), action: () => send('openUrl', info.webUrl) });
  return entries;
}

/** Actions of a branch / tag node (Git.Branch.Backend + branches popup), with IntelliJ texts. */
export function refActions(r: Ref, current: string | undefined): MenuEntry[] {
  const root = r.root ?? store.root;
  if (r.root) current = store.repos.find(x => x.root === r.root)?.head.branch ?? current;
  const cur = current ?? 'HEAD';
  const act = (id: string) => () => send('branchAction', { id, name: r.name, type: r.type, root });
  if (r.type === 'tag') {
    return [
      { label: t('Checkout'), action: act('checkout') },
      { label: t("New Branch from '{0}'…", r.name), action: () => send('command', { id: 'ideagittool.createBranch', args: { root, startPoint: r.name } }) },
      { separator: true },
      { label: t("Compare with '{0}'", cur), action: () => send('command', { id: 'ideagittool.compareRefs', args: { root, ref: r.name, with: cur } }) },
      { label: t('Show Diff with Working Tree'), action: () => send('command', { id: 'ideagittool.branch.showDiffWithWorkingTree', args: { root, name: r.name, type: 'tag' } }) },
      { separator: true },
      { label: t("Merge '{0}' into '{1}'", r.name, cur), action: act('mergeIntoCurrent') },
      { separator: true },
      { label: t('Push Tag…'), action: act('push') },
      { separator: true },
      { label: t('Delete'), icon: 'general/delete', action: act('delete') },
    ];
  }
  const isCurrent = r.type === 'local' && r.name === current;
  if (isCurrent) {
    return [
      { label: t("New Branch from '{0}'…", r.name), action: act('newBranchFrom') },
      { separator: true },
      { label: t('Update'), icon: 'vcs/update', action: act('update') },
      { label: t('Push…'), icon: 'vcs/push', shortcut: 'Ctrl+Shift+K', action: act('push') },
      { label: t('Tracked Branch…'), action: act('trackRemote') },
      { separator: true },
      { label: t('Rename…'), shortcut: 'F2', action: act('rename') },
      { separator: true },
      { label: r.favorite ? t('Remove from Favorites') : t('Add to Favorites'), icon: r.favorite ? 'nodes/star' : 'nodes/starEmpty', action: act('toggleFavorite') },
    ];
  }
  const entries: MenuEntry[] = [
    { label: t('Checkout'), action: act('checkout') },
    { label: t("New Branch from '{0}'…", r.name), action: act('newBranchFrom') },
    { label: t("Checkout and Rebase onto '{0}'", cur), disabled: !current, action: act('checkoutAndRebase') },
    { separator: true },
    { label: t("Compare with '{0}'", cur), action: act('compare') },
    { label: t('Show Diff with Working Tree'), action: act('showDiffWithWorkingTree') },
    { separator: true },
    { label: t("Rebase '{0}' onto '{1}'", cur, r.name), disabled: !current, action: act('rebaseCurrentOnto') },
    { label: t("Merge '{0}' into '{1}'", r.name, cur), action: act('mergeIntoCurrent') },
    { separator: true },
  ];
  if (r.type === 'local') {
    entries.push(
      { label: t('Update'), icon: 'vcs/update', disabled: !r.upstream, action: act('update') },
      { label: t('Push…'), icon: 'vcs/push', action: act('push') },
      { label: t('Tracked Branch…'), action: act('trackRemote') },
      { separator: true },
      { label: t('Rename…'), action: act('rename') },
      { label: t('Delete'), icon: 'general/delete', action: act('delete') },
    );
  } else {
    entries.push(
      { label: t("Pull into '{0}' Using Rebase", cur), disabled: !current, action: act('pullRebase') },
      { label: t("Pull into '{0}' Using Merge", cur), disabled: !current, action: act('pullMerge') },
      { separator: true },
      { label: t('Delete'), icon: 'general/delete', action: act('delete') },
    );
  }
  entries.push({ separator: true }, { label: r.favorite ? t('Remove from Favorites') : t('Add to Favorites'), icon: r.favorite ? 'nodes/star' : 'nodes/starEmpty', action: act('toggleFavorite') });
  return entries;
}

export function changeAction(id: string, changes: Change[]) {
  const d = store.details;
  if (!d || !changes.length) return;
  send('changeAction', { id, changes, left: d.left, right: d.right, hashes: store.selectedRows().map(r => r.h) });
}

/** Vcs.Log.ChangesBrowser.Popup */
export async function changesMenu(anchor: Anchor, changes: Change[]) {
  const none = changes.length === 0;
  const c = (id: string) => () => changeAction(id, changes);
  const single = store.selection.size === 1;
  const merge = single && (store.selectedRows()[0]?.p.length ?? 0) > 1;
  // In-memory editing (GitSingleCommitEditingAction): one commit of the current branch, no merges, no operation in progress.
  const info = single ? await call<ContextInfo>('contextInfo', store.selectedRows().map(r => r.h)) : undefined;
  const editable = !!info && info.inHead && !info.hasMerges && info.operation === 'none' && !none;
  const all = changes.length >= (store.details?.changes.length ?? 0);
  showMenu(
    [
      { label: t('Show Diff'), icon: 'vcs/diff', shortcut: 'Ctrl+D', disabled: none, action: c('diff') },
      { label: t('Compare with Local'), disabled: none, action: c('compareWithLocal') },
      { label: t('Compare Before with Local'), disabled: none, action: c('compareBeforeWithLocal') },
      { label: t('Edit Source'), icon: 'general/edit', shortcut: 'F4', disabled: none, action: c('editSource') },
      { label: t('Open Repository Version'), disabled: none, action: c('openRepositoryVersion') },
      { separator: true },
      { label: t('Revert Selected Changes'), icon: 'vcs/revert', disabled: none, action: c('revertSelected') },
      { label: t('Cherry-Pick Selected Changes'), disabled: none, action: c('applySelected') },
      { label: t('Drop Selected Changes'), disabled: !editable, action: c('dropSelected') },
      { label: t('Extract Selected Changes to Separate Commit…'), disabled: !editable || all, action: c('extractSelected') },
      { label: t('Create Patch…'), icon: 'vcs/patch', disabled: none, action: c('createPatch') },
      { label: t('Get'), icon: 'general/download', disabled: none, action: c('get') },
      { label: t('History Up to Here'), icon: 'general/history', disabled: changes.length !== 1, action: c('historyUpToHere') },
      { separator: true },
      { label: t('Copy Path'), icon: 'general/copy', disabled: none, action: c('copyPath') },
      { label: t('Copy Absolute Path'), disabled: none, action: c('copyAbsolutePath') },
      { separator: true },
      {
        label: t('Show Changes to Parents'),
        checked: store.showChangesToParents,
        disabled: !merge,
        action: () => {
          store.showChangesToParents = !store.showChangesToParents;
          void store.loadDetails();
        },
      },
    ],
    anchor,
  );
}

/** Vcs.Log.PresentationSettings ("View Options", eye icon). */
export function viewOptionsMenu(): MenuEntry[] {
  const s = store.settings;
  const toggle = (key: keyof typeof s) => () => store.updateSettings({ [key]: !s[key] } as any);
  const col = (key: 'author' | 'date' | 'hash' | 'signature') => () => store.updateSettings({ columns: { ...s.columns, [key]: !s.columns[key] } });
  return [
    { separator: true, label: t('Show') },
    ...(store.init.multi ? [{ label: t('Root Names'), checked: s.showRootNames, action: toggle('showRootNames') }] : []),
    { label: t('Compact References View'), checked: s.compactRefs, action: toggle('compactRefs') },
    { label: t('Tag Names'), checked: s.showTagNames, action: toggle('showTagNames') },
    { label: t('Long Edges'), checked: s.showLongEdges, action: toggle('showLongEdges') },
    { label: t('Commit Timestamp'), checked: s.preferCommitDate, action: toggle('preferCommitDate') },
    { label: t('References on the Left'), checked: s.refsOnLeft, action: toggle('refsOnLeft') },
    {
      label: t('Columns'),
      children: [
        { label: t('Author'), checked: s.columns.author, action: col('author') },
        { label: t('Date'), checked: s.columns.date, action: col('date') },
        { label: t('Hash'), checked: s.columns.hash, action: col('hash') },
        { label: t('GPG Signature'), checked: s.columns.signature, action: col('signature') },
      ],
    },
    { separator: true, label: t('Highlight') },
    { label: t('My Commits'), checked: s.highlightMyCommits, action: toggle('highlightMyCommits') },
    { label: t('Merge Commits'), checked: s.highlightMergeCommits, action: toggle('highlightMergeCommits') },
    { label: t('Current Branch'), checked: s.highlightCurrentBranch, action: toggle('highlightCurrentBranch') },
    ...(store.init.mode === 'log'
      ? [{ label: t('Not Cherry-Picked Commits'), checked: !!store.cherryPick, disabled: store.head.detached, action: toggleCherryPicked }]
      : []),
    ...(store.init.mode === 'history' ? [{ separator: true } as MenuEntry, layoutMenu()] : []),
  ];
}

/** Configure Layout ▸ (file history View Options and the changes browser). */
export function layoutMenu(): MenuEntry {
  const s = store.settings;
  return {
    label: t('Configure Layout'),
    icon: 'general/layout',
    children: [
      { separator: true, label: t('Layout') },
      { label: t('Show Details'), checked: s.showDetails, action: () => store.updateSettings({ showDetails: !s.showDetails }) },
      { label: t('Show Diff Preview'), checked: s.showDiffPreview, action: () => store.updateSettings({ showDiffPreview: !s.showDiffPreview }) },
      {
        label: t('Diff Preview Location'),
        children: [
          { label: t('Bottom'), checked: s.diffPreviewLocation === 'bottom', action: () => store.updateSettings({ diffPreviewLocation: 'bottom', showDiffPreview: true }) },
          { label: t('Right'), checked: s.diffPreviewLocation === 'right', action: () => store.updateSettings({ diffPreviewLocation: 'right', showDiffPreview: true }) },
        ],
      },
    ],
  };
}

/**
 * HighlightCherryPickedCommitsAction: dims the commits of the filtered branch that are already
 * cherry-picked to the current branch. Without a single branch filter, asks for the source branch.
 */
function toggleCherryPicked() {
  if (store.cherryPick) {
    store.cherryPick = undefined;
    store.emit();
    return;
  }
  const f = store.filters.branches;
  if (f.length === 1 && f[0] !== 'HEAD' && f[0] !== store.currentBranch && store.refs.some(r => r.name === f[0])) {
    void store.loadCherryPicked(f[0]);
    return;
  }
  const pick = (name: string) => () => {
    void store.setFilters({ ...store.filters, branches: [name] }).then(() => store.loadCherryPicked(name));
  };
  const seen = new Set<string>();
  const refs = store.refs.filter(r => r.type !== 'tag' && r.name !== store.currentBranch && !seen.has(r.name) && seen.add(r.name));
  showMenu(
    [
      { separator: true, label: t('Local') },
      ...refs.filter(r => r.type === 'local').map(r => ({ label: r.name, action: pick(r.name) })),
      { separator: true, label: t('Remote') },
      ...refs.filter(r => r.type === 'remote').map(r => ({ label: r.name, action: pick(r.name) })),
    ],
    { x: window.innerWidth / 2 - 100, y: 60 },
    { title: t('Select Source Branch') },
  );
}

/** Vcs.Log.GraphOptionsGroup (IntelliSort icon in the filter bar). */
export function graphOptionsMenu(): MenuEntry[] {
  const o = store.options;
  return [
    { separator: true, label: t('Sort') },
    { label: t('By Commit Date'), checked: o.sort === 'date', action: () => void store.setFilters(store.filters, { ...o, sort: 'date' }) },
    { label: t('Topologically'), checked: o.sort === 'topo', action: () => void store.setFilters(store.filters, { ...o, sort: 'topo' }) },
    { separator: true, label: t('Options') },
    { label: t('First Parent'), checked: o.firstParent, action: () => void store.setFilters(store.filters, { ...o, firstParent: !o.firstParent }) },
    { label: t('No Merges'), checked: !!o.noMerges, action: () => void store.setFilters(store.filters, { ...o, noMerges: !o.noMerges }) },
    { separator: true, label: t('Branch Actions') },
    { label: t('Collapse Linear Branches'), icon: 'general/collapseAll', disabled: !!o.collapseLinear || structureBroken(), action: () => void store.setFilters(store.filters, { ...o, collapseLinear: true }) },
    { label: t('Expand Linear Branches'), icon: 'general/expandAll', disabled: !o.collapseLinear, action: () => void store.setFilters(store.filters, { ...o, collapseLinear: false }) },
  ];
}

function structureBroken() {
  const f = store.filters;
  return !!(f.text || f.users.length || f.since || f.until);
}
