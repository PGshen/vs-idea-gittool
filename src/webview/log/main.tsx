import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '../lib/base.css';
import './log.css';
import { Split } from '../lib/components';
import { Icon } from '../lib/icons';
import { call, on, send } from '../lib/rpc';
import { BranchesPanel } from './branches';
import { RightPanel } from './changes';
import { FilterBar } from './filterBar';
import { updateGraphTheme } from './graph';
import { REF_MASK } from './refs';
import { store, useStore } from './store';
import { LogTable } from './table';

function GoTo({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const go = async () => {
    const q = value.trim();
    if (!q) return;
    const local = store.refs.find(r => r.name === q)?.hash ?? q;
    const i = store.indexOfHash(local);
    if (i >= 0) {
      await store.selectIndex(i);
      onClose();
      return;
    }
    const r = await call<{ index: number; hash: string } | undefined>('find', q);
    if (r) {
      await store.selectIndex(r.index, { hash: r.hash });
      onClose();
    } else setError(true);
  };
  return (
    <div class="go-to">
      <input
        ref={input}
        class={`text-field ${error ? 'error' : ''}`}
        placeholder="Enter hash or branch/tag name"
        value={value}
        list="go-to-refs"
        onInput={e => {
          setValue((e.currentTarget as HTMLInputElement).value);
          setError(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') void go();
          if (e.key === 'Escape') {
            onClose();
            document.getElementById('log-table')?.focus();
          }
        }}
        onBlur={() => setTimeout(onClose, 150)}
      />
      <datalist id="go-to-refs">
        {store.refs.map(r => (
          <option key={r.fullName} value={r.name} />
        ))}
      </datalist>
    </div>
  );
}

function CompareBanner() {
  const s = useStore();
  const c = s.init.compare;
  if (!c) return null;
  return (
    <div class="banner compare-banner">
      <Icon name="vcs/diff" />
      <span>
        Commits in <b>{c.ref}</b> that are not in <b>{c.with}</b>
      </span>
      <span class="spacer" />
      <span class="link" onClick={() => send('command', { id: 'rebased.compareRefs', args: { root: s.root, ref: c.with, with: c.ref } })}>
        Swap Branches
      </span>
      <span class="link" onClick={() => send('command', { id: 'rebased.compareRefs.files', args: { root: s.root, ref: c.ref, with: c.with } })}>
        Show Files Diff
      </span>
    </div>
  );
}

function OperationBanner() {
  const s = useStore();
  const op = s.head.operation;
  if (op === 'none' || s.init.mode !== 'log') return null;
  const names: Record<string, string> = { rebase: 'Rebasing', merge: 'Merging', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', bisect: 'Bisecting', am: 'Applying patches' };
  return (
    <div class="banner warning">
      <span>
        {names[op] ?? op} {s.currentBranch ? `'${s.currentBranch}'` : ''} is in progress
      </span>
      <span class="spacer" />
      {op !== 'bisect' && (
        <>
          <span class="link" onClick={() => send('command', { id: 'rebased.continueOperation', args: { root: s.root } })}>
            Continue
          </span>
          {op === 'rebase' && (
            <span class="link" onClick={() => send('command', { id: 'rebased.skipCommit', args: { root: s.root } })}>
              Skip
            </span>
          )}
          <span class="link" onClick={() => send('command', { id: 'rebased.abortOperation', args: { root: s.root } })}>
            Abort
          </span>
        </>
      )}
    </div>
  );
}

function App() {
  const s = useStore();
  const [goTo, setGoTo] = useState(false);
  const settings = s.settings;
  const history = s.init.mode === 'history';
  const showBranches = settings.showBranches && !history;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setGoTo(true);
      } else if (ctrl && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        document.getElementById('text-filter')?.focus();
      } else if (e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        send('newTab', { filters: store.filters });
      } else if ((ctrl && e.key === 'F5') || e.key === 'F5') {
        e.preventDefault();
        void store.setFilters(store.filters);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const center = (
    <div class="center">
      <FilterBar onGoTo={() => setGoTo(true)} />
      <CompareBanner />
      <OperationBanner />
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {goTo && <GoTo onClose={() => setGoTo(false)} />}
        <LogTable />
      </div>
    </div>
  );

  const main = (
    <Split persistKey="right" initial={settings.rightWidth} second min={160}>
      {center}
      <RightPanel />
    </Split>
  );

  return (
    <div class="log-root">
      {!history && !showBranches && (
        <div class="branches-stripe">
          <span class="stripe-toggle" data-tip="Show Branches" onClick={() => store.updateSettings({ showBranches: true })}>
            <Icon name="general/chevronRight" />
          </span>
          <span class="stripe-label" onClick={() => store.updateSettings({ showBranches: true })}>
            Branches
          </span>
        </div>
      )}
      {showBranches ? (
        <Split persistKey="branches" initial={settings.branchesWidth} min={140}>
          <BranchesPanel onHide={() => store.updateSettings({ showBranches: false })} />
          {main}
        </Split>
      ) : (
        main
      )}
    </div>
  );
}

document.documentElement.style.setProperty('--ref-mask', REF_MASK());
updateGraphTheme();
on('themeChanged', () => {
  updateGraphTheme();
  store.emit();
});
render(<App />, document.getElementById('root')!);
void store.start().then(() => document.getElementById('log-table')?.focus({ preventScroll: true }));
