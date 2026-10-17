import { useEffect, useMemo, useState } from 'preact/hooks';
import { Button, Checkbox } from '../../../lib/components';
import { FileIcon, Icon } from '../../../lib/icons';
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
}

interface Payload {
  rows: ConflictRow[];
  resolved: ConflictRow[];
  text: string;
  yours: string;
  theirs: string;
}

type Line = { type: 'group'; label: string; count: string; key: string } | { type: 'dir'; label: string; key: string; depth: number } | { type: 'file'; row: ConflictRow; depth: number; resolved: boolean };

/**
 * The Conflicts dialog in iterative mode (MultipleFileMergeDialog with `vcs.merge.conflict.iterative.resolution`):
 * Unresolved / Resolved groups, columns Name / Yours / Theirs, and the resolve buttons on the right.
 */
registerDialog<Payload>('commit.conflicts', ({ props, cancel }) => {
  const [data, setData] = useState<Payload>(props);
  const [selected, setSelected] = useState<Set<string>>(new Set(props.rows[0] ? [props.rows[0].key] : []));
  const [groupByDir, setGroupByDir] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => on('rows', (p: Payload) => setData(p)), []);
  useEffect(() => on('close', () => cancel()), []);

  const lines = useMemo(() => {
    const out: Line[] = [];
    const add = (rows: ConflictRow[], resolved: boolean) => {
      const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path));
      if (!groupByDir) {
        sorted.forEach(row => out.push({ type: 'file', row, depth: 1, resolved }));
        return;
      }
      let lastDir: string | undefined;
      for (const row of sorted) {
        const dir = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '';
        if (dir !== lastDir) {
          if (dir) out.push({ type: 'dir', label: dir, key: `${resolved}:${dir}`, depth: 1 });
          lastDir = dir;
        }
        out.push({ type: 'file', row, depth: dir ? 2 : 1, resolved });
      }
    };
    const total = data.rows.length + data.resolved.length;
    out.push({ type: 'group', label: 'Unresolved', count: `${data.rows.length}/${total}`, key: 'g:unresolved' });
    add(data.rows, false);
    if (data.resolved.length) {
      out.push({ type: 'group', label: 'Resolved', count: `${data.resolved.length}/${total}`, key: 'g:resolved' });
      add(data.resolved, true);
    }
    return out;
  }, [data, groupByDir]);

  const unresolvedSel = data.rows.filter(r => selected.has(r.key));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const accept = (yours: boolean) => run(() => call('accept', { keys: unresolvedSel.map(r => r.key), yours }));
  const merge = () => unresolvedSel[0] && run(() => call('merge', { key: unresolvedSel[0].key }));
  const done = data.rows.length === 0;

  const click = (e: MouseEvent, key: string) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(key) ? next.delete(key) : next.add(key);
      setSelected(next);
    } else setSelected(new Set([key]));
  };

  return (
    <DialogFrame
      title="Conflicts"
      width={820}
      height={520}
      resizable
      onCancel={cancel}
      onOk={done ? cancel : merge}
      left={<Checkbox checked={groupByDir} onChange={setGroupByDir} label="Group by directory" />}
      buttons={
        <Button primary={done} onClick={cancel}>
          Close
        </Button>
      }
    >
      <div style={{ userSelect: 'text' }}>{data.text || (data.rows.length === 1 ? 'The following file has conflicts:' : 'The following files have conflicts:')}</div>
      <div style={{ display: 'flex', gap: '12px', flex: 1, minHeight: 0 }}>
        <div class="panel-box" style={{ flex: 1, overflow: 'auto' }} tabIndex={0}>
          <table class="table conflicts-table">
            <thead>
              <tr>
                <th></th>
                <th style={{ width: '20%' }}>{data.yours}</th>
                <th style={{ width: '20%' }}>{data.theirs}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l =>
                l.type === 'group' ? (
                  <tr key={l.key}>
                    <td colSpan={3} style={{ fontWeight: 600 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Icon name="general/chevronDown" />
                        {l.label}
                        <span class="secondary" style={{ fontWeight: 'normal', marginLeft: '4px' }}>
                          {l.count}
                        </span>
                      </span>
                    </td>
                  </tr>
                ) : l.type === 'dir' ? (
                  <tr key={l.key}>
                    <td colSpan={3} style={{ paddingLeft: `${8 + l.depth * 20}px` }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Icon name="nodes/folder" /> {l.label}
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={l.row.key}
                    class={selected.has(l.row.key) ? 'selected' : ''}
                    onMouseDown={e => click(e, l.row.key)}
                    onDblClick={() => (l.resolved ? call('showDiff', { key: l.row.key }) : run(() => call('merge', { key: l.row.key })))}
                    title={`${l.row.path} — ${l.row.kind}`}
                  >
                    <td style={{ paddingLeft: `${8 + l.depth * 20}px` }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <FileIcon path={l.row.path} />
                        <span class={l.resolved ? '' : 'st-U'}>{groupByDir ? l.row.path.slice(l.row.path.lastIndexOf('/') + 1) : l.row.path}</span>
                      </span>
                    </td>
                    <td class={l.row.yours === 'Deleted' ? 'secondary' : ''}>{l.resolved ? '' : l.row.yours}</td>
                    <td class={l.row.theirs === 'Deleted' ? 'secondary' : ''}>{l.resolved ? '' : l.row.theirs}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {done && (
            <div class="empty-text" style={{ color: 'var(--fg-success)' }}>
              All conflicts have been resolved
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '210px' }}>
          <Button
            disabled={busy || done}
            tip="Apply all non-conflicting changes and resolve simple conflicts"
            onClick={() => run(() => call('resolveSimple'))}
          >
            Resolve All Simple Conflicts
          </Button>
          <Button disabled={busy || !unresolvedSel.length} onClick={() => accept(true)}>
            Accept ‘Yours’
          </Button>
          <Button disabled={busy || !unresolvedSel.length} onClick={() => accept(false)}>
            Accept ‘Theirs’
          </Button>
          <Button primary={!done} disabled={busy || unresolvedSel.length !== 1 || unresolvedSel[0].kind !== 'both modified' && unresolvedSel[0].kind !== 'both added'} onClick={merge}>
            Resolve Manually…
          </Button>
          {busy && <span class="spinner" style={{ alignSelf: 'center' }} />}
        </div>
      </div>
    </DialogFrame>
  );
});
