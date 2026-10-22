import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import './diffView.css';
import type { FileDiffResult } from '../../shared/logProtocol';
import { alignHunks, innerRange, isGap, Item, Kind, SideRow } from './diffAlign';
import type { Change } from '../../shared/types';
import { ActionButton, Spacer, Toolbar } from '../lib/components';
import { FileIcon } from '../lib/icons';
import { anchorAt, showMenu } from '../lib/menu';
import { call } from '../lib/rpc';
import { changeAction } from './menus';
import { store, useStore } from './store';

function Text({ s, from, to, kind }: { s: string; from?: number; to?: number; kind: Kind }) {
  if (from === undefined || to === undefined || kind !== 'modified' || to <= from) return <span>{s || ' '}</span>;
  return (
    <span>
      {s.slice(0, from)}
      <span class="inner">{s.slice(from, to)}</span>
      {s.slice(to)}
    </span>
  );
}

function SideBySide({ items, onExpand }: { items: Item[]; onExpand: () => void }) {
  return (
    <>
      {items.map((it, i) => {
        if (isGap(it)) {
          return (
            <div key={i} class="diff-gap" onClick={onExpand} data-tip="Expand">
              <span>{it.gap} unchanged {it.gap === 1 ? 'line' : 'lines'}</span>
            </div>
          );
        }
        const [la, lb, ra, rb] = it.kind === 'modified' && it.left && it.right ? innerRange(it.left.s, it.right.s) : [];
        return (
          <div key={i} class={`diff-row ${it.kind}`} data-block={it.block}>
            <span class="ln">{it.left?.n ?? ''}</span>
            <span class={`code left ${it.left ? '' : 'filler'}`}>{it.left && <Text s={it.left.s} from={la} to={lb} kind={it.kind} />}</span>
            <span class="ln">{it.right?.n ?? ''}</span>
            <span class={`code right ${it.right ? '' : 'filler'}`}>{it.right && <Text s={it.right.s} from={ra} to={rb} kind={it.kind} />}</span>
          </div>
        );
      })}
    </>
  );
}

function Unified({ items, onExpand }: { items: Item[]; onExpand: () => void }) {
  const out: preact.JSX.Element[] = [];
  let k = 0;
  // Changed blocks: all removed lines first, then all added lines (UnifiedDiffViewer).
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isGap(it)) {
      out.push(
        <div key={k++} class="diff-gap" onClick={onExpand} data-tip="Expand">
          <span>{it.gap} unchanged {it.gap === 1 ? 'line' : 'lines'}</span>
        </div>,
      );
      continue;
    }
    if (it.kind === 'equal') {
      out.push(
        <div key={k++} class="diff-row unified equal">
          <span class="ln">{it.left!.n}</span>
          <span class="ln">{it.right!.n}</span>
          <span class="code">{it.left!.s || ' '}</span>
        </div>,
      );
      continue;
    }
    const block: SideRow[] = [];
    while (i < items.length && !isGap(items[i]) && (items[i] as SideRow).block === it.block) block.push(items[i++] as SideRow);
    i--;
    for (const r of block)
      if (r.left)
        out.push(
          <div key={k++} class={`diff-row unified ${it.kind === 'inserted' ? 'inserted' : 'deleted'}`} data-block={it.block}>
            <span class="ln">{r.left.n}</span>
            <span class="ln" />
            <span class="code">{r.left.s || ' '}</span>
          </div>,
        );
    for (const r of block)
      if (r.right)
        out.push(
          <div key={k++} class="diff-row unified inserted" data-block={it.block}>
            <span class="ln" />
            <span class="ln">{r.right.n}</span>
            <span class="code">{r.right.s || ' '}</span>
          </div>,
        );
  }
  return <>{out}</>;
}

/**
 * Diff preview of the log (VcsLogChangeProcessor + SimpleDiffViewer / UnifiedDiffViewer):
 * shows the file selected in the changes tree. Double click in the tree still opens the VS Code diff editor.
 */
export function DiffPreview() {
  const s = useStore();
  const change = s.previewChange ?? s.details?.changes[0];
  const settings = s.settings;
  const [diff, setDiff] = useState<FileDiffResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [full, setFull] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const d = s.details;
  const revs = change && d ? (d.revs?.[change.root] ?? { left: d.left, right: d.right }) : undefined;
  const collapse = settings.diffCollapseUnchanged && !full;

  useEffect(() => setFull(false), [change, d]);

  useEffect(() => {
    if (!change || !revs) {
      setDiff(undefined);
      return;
    }
    let live = true;
    setLoading(true);
    void call<FileDiffResult>('fileDiff', { change, left: revs.left, right: revs.right, context: collapse ? 3 : 1000000 })
      .then(r => live && setDiff(r))
      .catch(() => live && setDiff(undefined))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [change?.root, change?.path, change?.oldPath, revs?.left, revs?.right, collapse]);

  const aligned = useMemo(() => (diff ? alignHunks(diff.hunks, diff.oldTotal, diff.newTotal) : undefined), [diff]);
  const [current, setCurrent] = useState(-1);
  useEffect(() => setCurrent(-1), [aligned]);

  const go = (dir: 1 | -1) => {
    if (!aligned?.blocks) return;
    const next = Math.max(0, Math.min(aligned.blocks - 1, current + dir));
    setCurrent(next);
    const el = body.current?.querySelector(`[data-block="${next}"]`) as HTMLElement | null;
    if (el && body.current) body.current.scrollTop = el.offsetTop - body.current.clientHeight / 3;
  };

  const toolbar = (
    <Toolbar class="diff-toolbar">
      <ActionButton icon="general/up" tip="Previous Difference" shortcut="Shift+F7" disabled={!aligned?.blocks || current <= 0} onClick={() => go(-1)} />
      <ActionButton icon="general/down" tip="Next Difference" shortcut="F7" disabled={!aligned?.blocks || current >= (aligned?.blocks ?? 0) - 1} onClick={() => go(1)} />
      <ActionButton icon="general/externalTools" tip="Open in Editor" disabled={!change} onClick={() => change && changeAction('diff', [change])} />
      <ActionButton icon="general/edit" tip="Jump to Source" shortcut="F4" disabled={!change || change.status === 'D'} onClick={() => change && changeAction('editSource', [change])} />
      <span class="toolbar-separator" />
      <ActionButton
        icon={settings.diffUnified ? 'diff/unified' : 'diff/sideBySide'}
        tip="Viewer"
        menu={() => [
          { label: 'Side-by-side viewer', icon: 'diff/sideBySide', checked: !settings.diffUnified, action: () => store.updateSettings({ diffUnified: false }) },
          { label: 'Unified viewer', icon: 'diff/unified', checked: settings.diffUnified, action: () => store.updateSettings({ diffUnified: true }) },
        ]}
      />
      <ActionButton icon="actions/unselectAll" tip="Collapse Unchanged Fragments" toggled={settings.diffCollapseUnchanged} onClick={() => store.updateSettings({ diffCollapseUnchanged: !settings.diffCollapseUnchanged })} />
      <Spacer />
      {change && (
        <span class="diff-title">
          <FileIcon path={change.path} />
          <span class={`st-${change.status}`}>{change.path}</span>
        </span>
      )}
      {aligned && <span class="secondary diff-count">{aligned.blocks === 0 ? 'No differences' : `${aligned.blocks} ${aligned.blocks === 1 ? 'difference' : 'differences'}`}</span>}
    </Toolbar>
  );

  let content: preact.ComponentChildren;
  if (!change) content = <div class="changes-empty">No file selected</div>;
  else if (!diff) content = loading ? <div class="changes-empty">Loading…</div> : <div class="changes-empty">Cannot show diff</div>;
  else if (diff.binary) content = <div class="changes-empty">Binary files differ</div>;
  else if (diff.tooLarge) content = <div class="changes-empty">File is too large to show the difference. <span class="link" onClick={() => changeAction('diff', [change as Change])}>Open in Editor</span></div>;
  else if (!aligned!.items.length) content = <div class="changes-empty">Contents are identical</div>;
  else
    content = settings.diffUnified ? <Unified items={aligned!.items} onExpand={() => setFull(true)} /> : <SideBySide items={aligned!.items} onExpand={() => setFull(true)} />;

  return (
    <div
      class="diff-preview"
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        showMenu([
          { label: 'Jump to Source', icon: 'general/edit', shortcut: 'F4', disabled: !change || change.status === 'D', action: () => change && changeAction('editSource', [change]) },
          { label: 'Open in Editor', icon: 'general/externalTools', disabled: !change, action: () => change && changeAction('diff', [change]) },
        ], anchorAt(e));
      }}
      onKeyDown={e => {
        if (e.key === 'F4' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (change && change.status !== 'D') changeAction('editSource', [change]);
        }
      }}
    >
      {toolbar}
      <div
        class={`diff-body mono ${settings.diffUnified ? 'unified' : 'side'}`}
        ref={body}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'F7') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      >
        {content}
      </div>
    </div>
  );
}
