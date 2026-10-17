import { useEffect, useMemo, useState } from 'preact/hooks';
import { ActionButton, Button } from '../../../lib/components';
import { FileIcon, Icon } from '../../../lib/icons';
import { anchorAt, showMenu } from '../../../lib/menu';
import { call, on } from '../../../lib/rpc';
import { DialogFrame } from '../../frame';
import { registerDialog } from '../../registry';

interface ConflictRow {
  key: string;
  root: string;
  repoName: string;
  path: string;
  kind: string;
  yours: string;
  theirs: string;
  badge?: { resolved: number; total: number };
  resolved: boolean;
  mergeable: boolean;
  reviewed: boolean;
}

interface Payload {
  rows: ConflictRow[];
  text: string;
  yours: string;
  theirs: string;
  showResolvedGroup: boolean;
  status: string;
  allResolvedAndReviewed: boolean;
  canFinish: boolean;
  canResolveAutomatically: boolean;
  busy: boolean;
}

type Line =
  | { type: 'group'; resolved: boolean; files: number; key: string }
  | { type: 'dir'; label: string; key: string; depth: number }
  | { type: 'file'; row: ConflictRow; depth: number };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** multiple.file.iterative.merge.tooltip */
function badgeTip(b: { resolved: number; total: number }) {
  if (b.resolved === 0) return plural(b.total, '1 change', `${b.total} changes`);
  return plural(b.resolved, '1 change has been merged', `${b.resolved} changes have been merged`);
}

/** The column names, `Yours` and `Theirs` as a fallback (MergeUIUtil.getYoursAndTheirsLabes). */
function sideLabel(column: string, fallback: string) {
  return column || fallback;
}

/**
 * The Conflicts dialog in the iterative flow (MultipleFileMergeDialog + IterativeMergeFlowDelegate): the description,
 * "Resolve All Simple Conflicts" with its status and the view options, the Unresolved / Resolved groups with the
 * "resolved/total" badges and the inline Accept buttons, and Close / Accept and Finish / Resolve Manually.
 */
registerDialog<Payload>('commit.conflicts', ({ props, cancel }) => {
  const [data, setData] = useState<Payload>(props);
  /** The first file row of the tree: unresolved files come first. */
  const firstFile = (p: Payload) => [...p.rows].sort((a, b) => Number(a.resolved) - Number(b.resolved) || order(a, b))[0]?.key;
  const [selected, setSelected] = useState<Set<string>>(new Set(firstFile(props) ? [firstFile(props)!] : []));
  const [groupByDir, setGroupByDir] = useState(false);
  const [hovered, setHovered] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState(false);
  useEffect(
    () =>
      on('rows', (p: Payload) => {
        setData(p);
        setSelected(sel => {
          const keep = new Set([...sel].filter(k => p.rows.some(r => r.key === k)));
          if (!keep.size && firstFile(p)) keep.add(firstFile(p)!);
          return keep;
        });
      }),
    [],
  );
  useEffect(() => on('close', () => cancel()), []);
  useEffect(() => on('reveal', () => window.focus()), []);

  const lines = useMemo(() => {
    const out: Line[] = [];
    const add = (rows: ConflictRow[], group: string) => {
      const sorted = [...rows].sort(order);
      if (!groupByDir) {
        sorted.forEach(row => out.push({ type: 'file', row, depth: 1 }));
        return;
      }
      let lastDir: string | undefined;
      for (const row of sorted) {
        const dir = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '';
        if (dir !== lastDir) {
          if (dir) out.push({ type: 'dir', label: dir, key: `${group}:${dir}`, depth: 1 });
          lastDir = dir;
        }
        out.push({ type: 'file', row, depth: dir ? 2 : 1 });
      }
    };
    const unresolved = data.rows.filter(r => !r.resolved);
    const resolved = data.rows.filter(r => r.resolved);
    if (unresolved.length) {
      out.push({ type: 'group', resolved: false, files: unresolved.length, key: 'g:unresolved' });
      if (!collapsed.has('g:unresolved')) add(unresolved, 'u');
    }
    if (resolved.length || data.showResolvedGroup) {
      out.push({ type: 'group', resolved: true, files: resolved.length, key: 'g:resolved' });
      if (!collapsed.has('g:resolved')) add(resolved, 'r');
    }
    return out;
  }, [data, groupByDir, collapsed]);

  const sel = data.rows.filter(r => selected.has(r.key));
  const disabled = data.busy || opening;
  const resolvedSelected = sel.some(r => r.resolved);
  const allSelectedResolved = sel.every(r => r.resolved);
  const onlyRevertable = sel.length > 0 && sel.every(r => (r.badge?.resolved ?? 0) > 0);
  const yoursLabel = sideLabel(data.yours, 'Yours');
  const theirsLabel = sideLabel(data.theirs, 'Theirs');

  const resolveManually = async () => {
    if (disabled) return;
    setOpening(true);
    try {
      await call('open', { keys: [...selected] });
    } finally {
      setOpening(false);
    }
  };
  const accept = (keys: string[], yours: boolean) => !disabled && call('accept', { keys, yours });
  const close = () => {
    if (!disabled) void call('close');
  };
  const finish = () => {
    if (!disabled && data.canFinish) void call('acceptAndFinish');
  };

  const click = (e: MouseEvent, key: string) => {
    if (e.button === 2 && selected.has(key)) return;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(key) ? next.delete(key) : next.add(key);
      setSelected(next);
    } else if (e.shiftKey && selected.size) {
      const files = lines.filter((l): l is Extract<Line, { type: 'file' }> => l.type === 'file').map(l => l.row.key);
      const a = files.findIndex(k => selected.has(k));
      const b = files.indexOf(key);
      setSelected(new Set(files.slice(Math.min(a, b), Math.max(a, b) + 1)));
    } else setSelected(new Set([key]));
  };

  const contextMenu = (e: MouseEvent) => {
    e.preventDefault();
    showMenu(
      [
        { label: `Accept ‘${yoursLabel}’`, disabled: disabled || resolvedSelected || !sel.length, action: () => accept([...selected], true) },
        { label: `Accept ‘${theirsLabel}’`, disabled: disabled || resolvedSelected || !sel.length, action: () => accept([...selected], false) },
        { separator: true },
        { label: 'Revert Conflict Resolution', icon: 'vcs/revert', disabled: disabled || !onlyRevertable, action: () => void call('revert', { keys: [...selected] }) },
      ],
      anchorAt(e),
    );
  };

  /** InlineButtonRenderer: the column label with an "Accept" button on the hovered row (or the only selected one). */
  const sideCell = (row: ConflictRow, yours: boolean) => {
    const show = !row.resolved && (hovered !== undefined ? hovered === row.key : sel.length === 1 && sel[0].key === row.key);
    return (
      <td class="conflicts-side">
        <span class="conflicts-side-label">{yours ? row.yours : row.theirs}</span>
        {show && (
          <button
            class="btn conflicts-accept"
            disabled={disabled}
            onClick={e => {
              e.stopPropagation();
              accept([row.key], yours);
            }}
          >
            Accept
          </button>
        )}
      </td>
    );
  };

  return (
    <DialogFrame
      title="Conflicts"
      width={850}
      height={data.rows.length <= 6 ? 470 : 570}
      resizable
      onCancel={close}
      onOk={data.allResolvedAndReviewed ? finish : resolveManually}
      buttons={
        <>
          <Button onClick={close} disabled={disabled}>
            Close
          </Button>
          <Button primary={data.allResolvedAndReviewed} disabled={disabled || !data.canFinish} onClick={finish}>
            Accept and Finish
          </Button>
          {!data.allResolvedAndReviewed && (
            <Button primary disabled={data.busy} onClick={resolveManually}>
              {allSelectedResolved ? 'Review Changes' : 'Resolve Manually'}
            </Button>
          )}
        </>
      }
    >
      <div class="conflicts-description" style={{ userSelect: 'text' }}>
        {data.allResolvedAndReviewed ? (
          <>
            <Icon name="status/success" /> All conflicts have been resolved
          </>
        ) : (
          data.text
        )}
      </div>
      <div class="conflicts-actions">
        <Button
          disabled={!data.canResolveAutomatically}
          tip={
            data.busy
              ? undefined
              : data.canResolveAutomatically
                ? 'Apply all non-conflicting changes and resolve simple conflicts (ones that can be resolved through static analysis) across all files'
                : 'There are no simple conflicts to resolve'
          }
          onClick={() => void call('resolveAutomatically')}
        >
          <span class="conflicts-magic">
            {data.busy ? <span class="spinner" /> : <Icon name="diff/magicResolve@14x14" />}
            {data.busy ? 'Resolving Conflicts…' : 'Resolve All Simple Conflicts'}
          </span>
        </Button>
        <span class="conflicts-status">{data.status}</span>
        <ActionButton
          icon="general/show"
          tip="View Options"
          menu={() => [{ label: 'Group by directory', icon: 'actions/toggleVisibility', checked: groupByDir, action: () => setGroupByDir(!groupByDir) }]}
        />
      </div>
      <div class={`panel-box conflicts-box ${disabled ? 'disabled' : ''}`} tabIndex={0} onMouseLeave={() => setHovered(undefined)}>
        <table class="table conflicts-table">
          <thead>
            <tr>
              <th></th>
              <th style={{ width: '22%' }}>{data.yours}</th>
              <th style={{ width: '22%' }}>{data.theirs}</th>
            </tr>
          </thead>
          <tbody onContextMenu={contextMenu}>
            {lines.map(l =>
              l.type === 'group' ? (
                <tr key={l.key} class="conflicts-group" onMouseEnter={() => setHovered(undefined)}>
                  <td colSpan={3}>
                    <span
                      class="conflicts-node"
                      onClick={() => {
                        const next = new Set(collapsed);
                        next.has(l.key) ? next.delete(l.key) : next.add(l.key);
                        setCollapsed(next);
                      }}
                    >
                      <Icon name={collapsed.has(l.key) ? 'general/chevronRight' : 'general/chevronDown'} />
                      <Icon name={l.resolved ? 'general/greenCheckmark' : 'vcs/remove'} />
                      <b>{l.resolved ? 'Resolved' : 'Unresolved'}</b>
                      <span class="secondary">{plural(l.files, '1 file', `${l.files} files`)}</span>
                    </span>
                  </td>
                </tr>
              ) : l.type === 'dir' ? (
                <tr key={l.key} onMouseEnter={() => setHovered(undefined)}>
                  <td colSpan={3} style={{ paddingLeft: `${8 + l.depth * 20}px` }}>
                    <span class="conflicts-node">
                      <Icon name="nodes/folder" /> {l.label}
                    </span>
                  </td>
                </tr>
              ) : (
                <tr
                  key={l.row.key}
                  data-key={l.row.key}
                  class={`conflicts-file ${selected.has(l.row.key) ? 'selected' : ''}`}
                  onMouseDown={e => !disabled && click(e, l.row.key)}
                  onMouseEnter={() => setHovered(l.row.key)}
                  onDblClick={() => void resolveManually()}
                  title={l.row.badge ? badgeTip(l.row.badge) : undefined}
                >
                  <td style={{ paddingLeft: `${8 + l.depth * 20}px` }}>
                    <span class="conflicts-node">
                      <FileIcon path={l.row.path} />
                      <span>{groupByDir ? l.row.path.slice(l.row.path.lastIndexOf('/') + 1) : l.row.path}</span>
                      {l.row.badge && (
                        <span class={`conflicts-badge ${l.row.badge.resolved > 0 ? 'modified' : ''}`}>
                          {l.row.badge.resolved}/{l.row.badge.total}
                        </span>
                      )}
                    </span>
                  </td>
                  {sideCell(l.row, true)}
                  {sideCell(l.row, false)}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </DialogFrame>
  );
});

function order(a: ConflictRow, b: ConflictRow) {
  return a.path.localeCompare(b.path);
}
