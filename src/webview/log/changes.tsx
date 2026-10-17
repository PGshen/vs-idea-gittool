import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Change, CommitDetails } from '../../shared/types';
import { ActionButton, buildDirectoryTree, Split, Spacer, Toolbar, Tree, TreeNode, walkTree } from '../lib/components';
import { fileIconName } from '../lib/icons';
import { anchorAt, MenuEntry } from '../lib/menu';
import { call, persisted, send } from '../lib/rpc';
import { changeAction, changesMenu, layoutMenu } from './menus';
import { refLabels, RefLabels } from './refs';
import { store, useStore } from './store';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const lower = (s: string) => s.replace(/\s?(AM|PM)$/, m => m.toLowerCase());
const onDate = (t: number) => `${dateFmt.format(new Date(t * 1000))} at ${lower(timeFmt.format(new Date(t * 1000)))}`;

type CNode = TreeNode<{ change?: Change }>;

const treeListeners = new Set<(cmd: 'expand' | 'collapse') => void>();
function treeCommand(cmd: 'expand' | 'collapse') {
  treeListeners.forEach(l => l(cmd));
}

function statusTip(c: Change) {
  const names: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Moved', C: 'Copied', T: 'Type changed' };
  return names[c.status] ?? c.status;
}

function fileNode(c: Change, flat: boolean): CNode {
  const name = c.path.slice(c.path.lastIndexOf('/') + 1);
  const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';
  let hint: string | undefined = flat && dir ? dir : undefined;
  if (c.oldPath) hint = `${hint ? hint + '  ' : ''}${c.status === 'C' ? 'copied' : 'moved'} from ${c.oldPath}`;
  return { key: `f:${c.oldPath ?? ''}>${c.path}`, label: name, text: name, icon: fileIconName(c.path), labelClass: `st-${c.status}`, hint, data: { change: c }, tip: `${c.path}\n${statusTip(c)}` };
}

function ChangesTree() {
  const s = useStore();
  const d = s.details;
  const grouped = s.settings.changesGroupByDirectory;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const changes = useMemo(() => {
    let list = d?.changes ?? [];
    if (s.settings.showOnlyAffectedChanges && s.filters.paths.length) {
      list = list.filter(c => s.filters.paths.some(p => c.path === p || c.path.startsWith(p + '/') || c.oldPath === p));
    }
    return list;
  }, [d, s.settings.showOnlyAffectedChanges, s.filters.paths]);

  const nodes = useMemo((): CNode[] => {
    if (!d) return [];
    if (d.toParents) {
      return d.toParents.map(tp => ({
        key: `parent:${tp.parent}`,
        label: `Changes to ${tp.parent.slice(0, 8)}`,
        icon: 'vcs/changelist',
        hint: `${tp.changes.length} ${tp.changes.length === 1 ? 'file' : 'files'}`,
        children: buildDirectoryTree(tp.changes, c => fileNode(c, !grouped), `${tp.parent}:`, { flat: !grouped }) as CNode[],
      }));
    }
    const n = changes.length;
    const roots = [...new Set(changes.map(c => c.root))];
    const byRepo = s.init.multi && s.settings.changesGroupByRepository && roots.length > 0;
    const children: CNode[] = byRepo
      ? roots.map(root => {
          const repo = s.repos.find(r => r.root === root);
          const list = changes.filter(c => c.root === root);
          return {
            key: `repo:${root}`,
            label: repo?.name ?? root,
            text: repo?.name ?? root,
            icon: 'nodes/folder',
            hint: `${list.length} ${list.length === 1 ? 'file' : 'files'}`,
            tip: root,
            children: buildDirectoryTree(list, c => fileNode(c, !grouped), `${root}:`, { flat: !grouped }) as CNode[],
          };
        })
      : (buildDirectoryTree(changes, c => fileNode(c, !grouped), '', { flat: !grouped }) as CNode[]);
    return [
      {
        key: 'root',
        label: `${n} ${n === 1 ? 'file' : 'files'}`,
        text: '',
        icon: 'nodes/folder',
        labelClass: 'secondary',
        children,
      },
    ];
  }, [changes, grouped, d, s.settings.changesGroupByRepository, s.repos]);

  const expanded = useMemo(() => {
    const all = new Set<string>();
    walkTree(nodes, n => n.children && !collapsed.has(n.key) && all.add(n.key));
    return all;
  }, [nodes, collapsed]);

  useEffect(() => {
    const l = (cmd: 'expand' | 'collapse') => {
      const c = new Set<string>();
      if (cmd === 'collapse') walkTree(nodes, n => n.children && n.key !== 'root' && c.add(n.key));
      setCollapsed(c);
    };
    treeListeners.add(l);
    return () => void treeListeners.delete(l);
  }, [nodes]);

  // Reset the selection when the commit changes.
  useEffect(() => {
    setSelection(new Set());
    store.previewChange = undefined;
  }, [d]);

  const selectedChanges = (sel = selection): Change[] => {
    const out: Change[] = [];
    walkTree(nodes, n => {
      if (sel.has(n.key)) {
        if (n.data?.change) out.push(n.data.change);
        else if (n.children) walkTree(n.children, c => c.data?.change && !out.includes(c.data.change) && out.push(c.data.change));
      }
    });
    return out;
  };

  if (!d) {
    return <div class="changes-empty">{s.selection.size ? (s.detailsLoading ? '' : 'Select commit to view changes') : 'No commits selected'}</div>;
  }
  if (changes.length === 0 && !d.toParents) {
    const merge = s.selection.size === 1 && (s.selectedRows()[0]?.p.length ?? 0) > 1;
    return (
      <div class="changes-empty">
        {merge ? (
          <>
            No merged conflicts.
            <br />
            <span class="link" onClick={() => ((store.showChangesToParents = true), void store.loadDetails())}>
              Show changes to parents
            </span>
          </>
        ) : s.settings.showOnlyAffectedChanges && s.filters.paths.length ? (
          <>
            No changes that affect selected paths.
            <br />
            <span class="link" onClick={() => store.updateSettings({ showOnlyAffectedChanges: false })}>
              Show changes for all paths
            </span>
          </>
        ) : (
          'No changes'
        )}
      </div>
    );
  }

  return (
    <Tree<{ change?: Change }>
      nodes={nodes}
      expanded={expanded}
      onExpandedChange={e => {
        const c = new Set<string>();
        walkTree(nodes, n => n.children && !e.has(n.key) && c.add(n.key));
        setCollapsed(c);
      }}
      selection={selection}
      onSelectionChange={(sel, lead) => {
        setSelection(sel);
        // The diff preview follows the selected file.
        if (lead?.data?.change && store.previewChange !== lead.data.change) {
          store.previewChange = lead.data.change;
          store.emit();
        }
      }}
      onOpen={n => n.data?.change && changeAction('diff', [n.data.change])}
      onKeyDown={(e, sel) => {
        const ch = selectedChanges(new Set(sel.map(n => n.key)));
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
          changeAction('diff', ch);
          return true;
        }
        if (e.key === 'F4') {
          changeAction('editSource', ch);
          return true;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          changeAction('copyPath', ch);
          return true;
        }
      }}
      onContextMenu={(e, sel) => changesMenu(anchorAt(e), selectedChanges(new Set(sel.map(n => n.key))))}
      emptyText="No changes"
    />
  );
}

/** Commit details (CommitDetailsPanel): message, hash/author/date, references, containing branches. */
function Details() {
  const s = useStore();
  const d = s.details;
  if (!d || !d.details.length) return <div class="details" />;
  const shown = d.details;
  return (
    <div class="details">
      {s.selection.size > shown.length && <div class="secondary">(showing {shown.length} of {s.selection.size} selected commits)</div>}
      {shown.map((c, i) => (
        <div key={c.hash}>
          {i > 0 && <div class="commit-sep" />}
          <CommitInfo c={c} single={shown.length === 1} />
        </div>
      ))}
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p, i) =>
    i % 2 ? (
      <a key={i} onClick={() => send('openUrl', p)}>
        {p}
      </a>
    ) : (
      p
    ),
  );
}

function CommitInfo({ c, single }: { c: CommitDetails; single: boolean }) {
  const s = useStore();
  const [branches, setBranches] = useState<string[] | undefined>();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setBranches(undefined);
    setShowAll(false);
    if (!single) return;
    let live = true;
    void call<string[]>('containing', c.hash).then(b => live && setBranches(b));
    return () => {
      live = false;
    };
  }, [c.hash, single]);
  const [subject, ...rest] = c.body.split('\n');
  const body = rest.join('\n').replace(/^\n+/, '');
  const labels = refLabels(c.refs, { compact: s.settings.compactRefs, showTagNames: true, currentBranch: s.currentBranch });
  const committedDiffers = c.committerName !== c.authorName || Math.abs(c.commitDate - c.authorDate) > 1;
  const sig = c.signature && c.signature !== 'N' ? c.signature : undefined;
  return (
    <>
      <div class="subject-line">{linkify(subject || c.subject)}</div>
      {body && <div class="body">{linkify(body)}</div>}
      <div class="meta">
        <span class="link hash" data-tip="Copy Revision Number" onClick={() => send('copy', c.hash)}>
          {c.hash.slice(0, 8)}
        </span>{' '}
        {c.authorName}{' '}
        <a href={`mailto:${c.authorEmail}`}>&lt;{c.authorEmail}&gt;</a> on {onDate(c.authorDate)}
        {committedDiffers && (
          <div class="committer">
            {c.committerName !== c.authorName ? `committed by ${c.committerName} on ${onDate(c.commitDate)}` : `committed on ${onDate(c.commitDate)}`}
          </div>
        )}
      </div>
      {sig && (
        <div class="section">
          <span class="sig" style={sig === 'G' ? undefined : { color: 'var(--fg-warning)' }}>
            {sig === 'G' ? '✔ Signed' : sig === 'B' ? '✘ Bad signature' : '? Signature cannot be verified'}
            {c.signer ? ` by ${c.signer}` : ''}
          </span>
        </div>
      )}
      {labels.length > 0 && (
        <div class="section">
          <RefLabels labels={labels} left />
        </div>
      )}
      {single && (
        <div class="section branch-list">
          {branches === undefined ? (
            <span class="secondary">In branches: loading…</span>
          ) : branches.length === 0 ? (
            <span>Not in any branch</span>
          ) : (
            <>
              In {branches.length} {branches.length === 1 ? 'branch' : 'branches'}:{' '}
              {showAll || branches.length <= 3 ? branches.join(', ') : `${branches.slice(0, 3).join(', ').slice(0, 30)}…`}{' '}
              {branches.length > 3 && (
                <span class="link" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Hide' : 'Show all'}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

export function RightPanel() {
  const s = useStore();
  const groupMenu = (): MenuEntry[] => [
    {
      label: 'Group By',
      icon: 'general/show',
      children: [
        { separator: true, label: 'Group By' },
        { label: 'Directory', shortcut: 'Ctrl+Alt+P', checked: s.settings.changesGroupByDirectory, action: () => store.updateSettings({ changesGroupByDirectory: !s.settings.changesGroupByDirectory }) },
        { label: 'Repository', checked: s.init.multi && s.settings.changesGroupByRepository, disabled: !s.init.multi, action: () => store.updateSettings({ changesGroupByRepository: !s.settings.changesGroupByRepository }) },
      ],
    },
    layoutMenu(),
  ];
  const allChanges = s.details?.changes ?? [];
  const tree = (
    <div class="right" style={{ height: '100%' }}>
      <Toolbar>
        <ActionButton icon="vcs/diff" tip="Show Diff" shortcut="Ctrl+D" disabled={!allChanges.length} onClick={() => changeAction('diff', allChanges)} />
        <ActionButton icon="vcs/revert" tip="Revert Selected Changes" disabled={!allChanges.length} onClick={() => changeAction('revertSelected', allChanges)} />
        <ActionButton icon="general/history" tip="History Up to Here" disabled={allChanges.length !== 1} onClick={() => changeAction('historyUpToHere', allChanges)} />
        {s.filters.paths.length > 0 && (
          <ActionButton icon="nodes/folder" tip="Show Only Affected Changes" toggled={s.settings.showOnlyAffectedChanges} onClick={() => store.updateSettings({ showOnlyAffectedChanges: !s.settings.showOnlyAffectedChanges })} />
        )}
        <ActionButton icon="general/show" tip="View Options" menu={groupMenu} />
        <Spacer />
        <ActionButton icon="general/expandAll" tip="Expand All" onClick={() => treeCommand('expand')} />
        <ActionButton icon="general/collapseAll" tip="Collapse All" onClick={() => treeCommand('collapse')} />
      </Toolbar>
      <ChangesTree />
    </div>
  );
  if (!s.settings.showDetails) return tree;
  return (
    <Split vertical persistKey="details" initial={persisted('detailsHeight', 240)} second min={60}>
      {tree}
      <Details />
    </Split>
  );
}
