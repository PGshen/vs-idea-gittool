import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import '../lib/base.css';
import './localHistory.css';
import { ActionButton, buildDirectoryTree, Separator, Split, Toolbar, Tree, TreeNode } from '../lib/components';
import { FileIcon, Icon } from '../lib/icons';
import { t } from '../lib/l10n';
import { boot, call, on, send } from '../lib/rpc';
import { LhDiff, LhDiffMode, LhFile, LhInit, LhItem } from '../../shared/localHistoryProtocol';
import { DiffView } from './diffView';

const init = boot.initial as LhInit;

const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return t('Today');
  if (same(d, yesterday)) return t('Yesterday');
  return dateFmt.format(d);
}

function itemIcon(it: LhItem) {
  if (it.kind === 'label') return 'nodes/tag';
  if (it.kind === 'system') return 'general/history';
  return it.kind === 'external' ? 'general/externalTools' : 'general/edit';
}

function App() {
  const [items, setItems] = useState<LhItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<number | undefined>(init.select);
  const [mode, setMode] = useState<LhDiffMode>('local');
  const [diff, setDiff] = useState<LhDiff | undefined>();
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(init.showSystem);
  const [tick, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => on('changed', () => setTick(n => n + 1)), []);
  useEffect(() => {
    call<LhItem[]>('items', { showSystem }).then(list => {
      setItems(list);
      setLoaded(true);
      setSelected(s => (s !== undefined && list.some(i => i.id === s) ? s : list[0]?.id));
    });
  }, [showSystem, tick]);
  useEffect(() => {
    if (selected === undefined) {
      setDiff(undefined);
      return;
    }
    call<LhDiff>('diff', { id: selected, mode }).then(setDiff, () => setDiff(undefined));
  }, [selected, mode, tick, items]);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return items;
    return items.filter(i => i.title.toLowerCase().includes(f) || i.paths.some(p => p.toLowerCase().includes(f)));
  }, [items, filter]);

  const move = (dir: number) => {
    const i = visible.findIndex(x => x.id === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + dir))];
    if (next) {
      setSelected(next.id);
      listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const fileMode = init.mode === 'file' || init.mode === 'selection';
  const sel = items.find(i => i.id === selected);
  const emptyText = !loaded
    ? t('Loading…')
    : filter
      ? init.mode === 'project'
        ? t('No matching recent activity detected')
        : t('No matching activity in {0} detected', init.displayName)
      : init.mode === 'project'
        ? t('No recent activity detected')
        : t('No activity in {0} detected', init.displayName);

  let lastDay = '';
  return (
    <Split persistKey="lh" initial={340} min={200}>
      <div class="lh-left">
        <Toolbar class="lh-toolbar">
          <div class="lh-search">
            <Icon name="general/search" />
            <input
              class="lh-search-input"
              placeholder={fileMode ? t('Search by content') : t('Search by file name')}
              value={filter}
              onInput={e => setFilter((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') move(1);
                if (e.key === 'ArrowUp') move(-1);
              }}
            />
          </div>
          <ActionButton
            icon="general/show"
            tip={t('View Options')}
            menu={() => [{ label: t('Show System Events'), checked: showSystem, action: () => (setShowSystem(!showSystem), send('setShowSystem', !showSystem)) }]}
          />
        </Toolbar>
        <div
          class="lh-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') (e.preventDefault(), move(1));
            if (e.key === 'ArrowUp') (e.preventDefault(), move(-1));
          }}
        >
          {visible.length === 0 && <div class="empty-text">{emptyText}</div>}
          {visible.map(it => {
            const day = dayLabel(it.ts);
            const header = day !== lastDay ? <div class="lh-day">{day}</div> : null;
            lastDay = day;
            return (
              <>
                {header}
                <div data-id={it.id} key={it.id} class={`lh-item ${it.id === selected ? 'selected' : ''} ${it.kind}`} onMouseDown={() => setSelected(it.id)} title={it.paths.join('\n')}>
                  <Icon name={itemIcon(it)} />
                  <span class="lh-title">{it.title}</span>
                  {!fileMode && it.files > 1 && <span class="secondary">{t('{0} files', it.files)}</span>}
                  <span class="lh-time secondary">{timeFmt.format(new Date(it.ts))}</span>
                </div>
              </>
            );
          })}
        </div>
      </div>
      <div class="lh-right">
        <Toolbar class="lh-toolbar">
          <ActionButton icon="vcs/revert" tip={t('Revert Selected and Later Changes')} disabled={!sel} onClick={() => sel && send('revert', { id: sel.id })} />
          {init.mode === 'selection' && <ActionButton icon="diff/revert@14x14" tip={t('Revert Selection')} disabled={!sel} onClick={() => sel && send('revertSelection', { id: sel.id })} />}
          <ActionButton icon="vcs/patch" tip={t('Create Patch…')} disabled={!sel} onClick={() => sel && send('createPatch', { id: sel.id, mode })} />
          <Separator />
          <ActionButton icon="vcs/diff" tip={t('Show Diff')} shortcut="Ctrl+D" disabled={!sel || !fileMode} onClick={() => sel && send('openDiff', { id: sel.id, mode })} />
          <span class="spacer" />
          {sel && (
            <span class="lh-mode secondary">
              {mode === 'local' ? t('Diff with the local directory.') : t('Diff with the next revision.')}{' '}
              <a class="link" onClick={() => setMode(mode === 'local' ? 'next' : 'local')}>
                {mode === 'local' ? t('Switch to diff with the next revision') : t('Switch to diff with the local directory')}
              </a>
            </span>
          )}
        </Toolbar>
        <div class="lh-diff">
          {!sel && <div class="empty-text">{items.length ? t('Select activity to view changes') : t('No changes detected')}</div>}
          {sel && diff?.kind === 'text' && <DiffView left={diff.left} right={diff.right} />}
          {sel && diff?.kind === 'empty' && <div class="empty-text">{diff.text}</div>}
          {sel && diff?.kind === 'files' && <FilesView files={diff.files} onOpen={f => send('openDiff', { id: sel.id, mode, path: f.path })} />}
        </div>
      </div>
    </Split>
  );
}

function FilesView({ files, onOpen }: { files: LhFile[]; onOpen: (f: LhFile) => void }) {
  const nodes = useMemo(
    () =>
      buildDirectoryTree(
        files.map(f => ({ ...f, path: f.rel, abs: f.path })),
        f =>
          ({
            key: `f:${f.abs}`,
            label: f.path.slice(f.path.lastIndexOf('/') + 1),
            text: f.path,
            prefix: <FileIcon path={f.path} />,
            labelClass: `st-${f.status}`,
            data: f,
          }) as TreeNode,
        '',
      ),
    [files],
  );
  const allDirs = useMemo(() => {
    const out = new Set<string>();
    const walk = (list: TreeNode[]) => list.forEach(n => n.children && (out.add(n.key), walk(n.children)));
    walk(nodes);
    return out;
  }, [nodes]);
  const [expanded, setExpanded] = useState<Set<string>>(allDirs);
  useEffect(() => setExpanded(allDirs), [allDirs]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  return (
    <div class="lh-files">
      <div class="secondary lh-files-head">
        {files.length === 1 ? t('{0} file', 1) : t('{0} files', files.length)}
      </div>
      <Tree
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={setExpanded}
        selection={selection}
        onSelectionChange={setSelection}
        onOpen={n => n.data && !n.children && onOpen({ path: n.data.abs, rel: n.data.path, status: n.data.status })}
      />
    </div>
  );
}

render(<App />, document.getElementById('root')!);
