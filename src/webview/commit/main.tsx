import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../lib/base.css';
import './commit.css';
import { boot, call, on, persist, persisted, send } from '../lib/rpc';
import { ActionButton } from '../lib/components';
import { CommitViewState } from '../../shared/commitProtocol';
import { BranchesTab } from './branchesTab';
import { CommitTab } from './commitTab';
import { ShelfTab } from './shelfTab';
import { StashTab } from './stashTab';

export type TabId = 'commit' | 'shelf' | 'stash' | 'branches';

function App() {
  const [state, setState] = useState<CommitViewState>(boot.initial.state);
  const [tab, setTab] = useState<TabId>(() => persisted<TabId>('tab', 'commit'));
  /** Bumped when the Branches tab is opened by a command (Ctrl+Shift+`): focuses its search field. */
  const [branchesFocus, setBranchesFocus] = useState(0);
  const show = (t: TabId) => {
    setTab(t);
    persist('tab', t);
    if (t === 'branches') setBranchesFocus(n => n + 1);
  };
  useEffect(() => on('state', setState), []);
  useEffect(() => on('selectTab', (t: TabId) => show(t)), []);
  useEffect(() => {
    // The view may have been created before the repositories were scanned.
    call<{ state: CommitViewState; tab?: TabId }>('ready').then(r => {
      setState(r.state);
      if (r.tab) show(r.tab);
    });
  }, []);
  const hasStashes = state.stashes.length > 0;
  const current: TabId = tab === 'stash' && !hasStashes ? 'commit' : tab;
  const select = (t: TabId) => {
    setTab(t);
    persist('tab', t);
  };
  return (
    <>
      <div class="tw-tabs">
        <span class={`tw-tab ${current === 'commit' ? 'selected' : ''}`} onClick={() => select('commit')}>
          Commit
        </span>
        <span class={`tw-tab ${current === 'shelf' ? 'selected' : ''}`} onClick={() => select('shelf')}>
          Shelf
        </span>
        {hasStashes && (
          <span class={`tw-tab ${current === 'stash' ? 'selected' : ''}`} onClick={() => select('stash')}>
            Stash
          </span>
        )}
        <span class={`tw-tab ${current === 'branches' ? 'selected' : ''}`} onClick={() => select('branches')}>
          Branches
        </span>
        <span style={{ flex: 1 }} />
        <ActionButton
          icon="general/moreVertical"
          tip="Options"
          menu={() => [
            {
              label: 'Show on Double-Click',
              children: [
                { label: 'Show Diff on Double-Click', checked: state.settings.doubleClick === 'diff', action: () => send('setSettings', { doubleClick: 'diff' }) },
                { label: 'Show Source on Double-Click', checked: state.settings.doubleClick === 'source', action: () => send('setSettings', { doubleClick: 'source' }) },
              ],
            },
            { separator: true },
            { label: 'Show Git Console', action: () => send('gitCommand', { command: 'ideagittool.showConsole' }) },
            { label: 'Show Git Log', icon: 'general/history', action: () => send('gitCommand', { command: 'ideagittool.showLog' }) },
          ]}
        />
      </div>
      <div class="tab-body" style={{ display: current === 'commit' ? 'flex' : 'none' }}>
        <CommitTab state={state} visible={current === 'commit'} />
      </div>
      {current === 'shelf' && (
        <div class="tab-body">
          <ShelfTab state={state} />
        </div>
      )}
      {current === 'stash' && (
        <div class="tab-body">
          <StashTab state={state} />
        </div>
      )}
      <div class="tab-body" style={{ display: current === 'branches' ? 'flex' : 'none' }}>
        <BranchesTab visible={current === 'branches'} focusToken={branchesFocus} />
      </div>
    </>
  );
}

render(<App />, document.getElementById('root')!);
