import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../lib/base.css';
import './commit.css';
import { boot, call, on, persist, persisted, send } from '../lib/rpc';
import { ActionButton } from '../lib/components';
import { CommitViewState } from '../../shared/commitProtocol';
import { CommitTab } from './commitTab';
import { ShelfTab } from './shelfTab';
import { StashTab } from './stashTab';

export type TabId = 'commit' | 'shelf' | 'stash';

function App() {
  const [state, setState] = useState<CommitViewState>(boot.initial.state);
  const [tab, setTab] = useState<TabId>(() => persisted<TabId>('tab', 'commit'));
  useEffect(() => on('state', setState), []);
  useEffect(
    () =>
      on('selectTab', (t: TabId) => {
        setTab(t);
        persist('tab', t);
      }),
    [],
  );
  useEffect(() => {
    // The view may have been created before the repositories were scanned.
    call<{ state: CommitViewState }>('ready').then(r => setState(r.state));
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
            { label: 'Show Git Console', action: () => send('gitCommand', { command: 'rebased.showConsole' }) },
            { label: 'Show Git Log', icon: 'general/history', action: () => send('gitCommand', { command: 'rebased.showLog' }) },
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
    </>
  );
}

render(<App />, document.getElementById('root')!);
