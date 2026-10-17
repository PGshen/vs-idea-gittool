import { useEffect, useState } from 'preact/hooks';
import { Button, Checkbox } from '../../../lib/components';
import { call, on } from '../../../lib/rpc';
import { Stash } from '../../../../shared/types';
import { DialogFrame, Row } from '../../frame';
import { registerDialog } from '../../registry';

interface RepoChoice {
  root: string;
  name: string;
  branch?: string;
}

function RootRows({ repos, root, setRoot }: { repos: RepoChoice[]; root: string; setRoot: (r: string) => void }) {
  const repo = repos.find(r => r.root === root);
  return (
    <>
      <Row label="Git root:">
        <select class="combo" value={root} onChange={e => setRoot((e.currentTarget as HTMLSelectElement).value)} disabled={repos.length < 2}>
          {repos.map(r => (
            <option value={r.root} key={r.root}>
              {r.root}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Current branch:">
        <span>{repo?.branch ?? ''}</span>
      </Row>
    </>
  );
}

/** Stash (GitStashDialog): Git root, current branch, message, Keep index, Include untracked; button Create Stash. */
registerDialog<{ repos: RepoChoice[]; root: string }>('commit.stash', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const [message, setMessage] = useState('');
  const [keepIndex, setKeepIndex] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const ok = () => submit({ root, message, keepIndex, includeUntracked });
  return (
    <DialogFrame
      title="Stash"
      width={520}
      onCancel={cancel}
      onOk={ok}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok}>
            Create Stash
          </Button>
        </>
      }
    >
      <div class="wide-labels" style={{ display: "contents" }}>
      <RootRows repos={props.repos} root={root} setRoot={setRoot} />
      <Row label="Message:">
        <input class="text-field" autofocus placeholder="Enter stash message here" value={message} onInput={e => setMessage((e.currentTarget as HTMLInputElement).value)} />
      </Row>
      <Checkbox checked={keepIndex} onChange={setKeepIndex} label="Keep index" tip="If this checkbox is selected, all changes already added to the index are left intact" />
      <Checkbox checked={includeUntracked} onChange={setIncludeUntracked} label="Include untracked" tip="If this checkbox is selected, all untracked files are also stashed" />
      </div>
    </DialogFrame>
  );
});

/**
 * Unstash Changes (GitUnstashDialog): stash list with View / Drop / Clear, "As new branch", Pop stash, Reinstate index.
 * The OK button text is Apply Stash / Pop Stash / Branch.
 */
registerDialog<{ repos: RepoChoice[]; root: string; ref?: string; stashes: Stash[] }>('commit.unstash', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const [stashes, setStashes] = useState<Stash[]>(props.stashes);
  const [selected, setSelected] = useState<string | undefined>(props.ref ?? props.stashes[0]?.ref);
  const [branch, setBranch] = useState('');
  const [pop, setPop] = useState(false);
  const [reinstate, setReinstate] = useState(false);
  const [error, setError] = useState<string>();

  const reload = async (r = root) => {
    const list = await call<Stash[]>('list', { root: r });
    setStashes(list);
    if (!list.some(s => s.ref === selected)) setSelected(list[0]?.ref);
  };
  useEffect(() => on('stashes', () => reload()), [root, selected]);

  const stash = stashes.find(s => s.ref === selected);
  const buttonText = branch.trim() ? 'Branch' : pop ? 'Pop Stash' : 'Apply Stash';
  const ok = async () => {
    if (!stash) return;
    setError(await submit({ root, ref: stash.ref, pop, reinstateIndex: reinstate, branch }));
  };
  return (
    <DialogFrame
      title="Unstash Changes"
      width={620}
      onCancel={cancel}
      onOk={ok}
      okDisabled={!stash}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary disabled={!stash} onClick={ok}>
            {buttonText}
          </Button>
        </>
      }
    >
      <div class="wide-labels" style={{ display: "contents" }}>
      <RootRows
        repos={props.repos}
        root={root}
        setRoot={r => {
          setRoot(r);
          void reload(r);
        }}
      />
      <Row label="Stashes:" top>
        <div class="panel-box" style={{ flex: 1, height: '220px', overflow: 'auto' }} tabIndex={0}>
          <table class="table">
            <tbody>
              {stashes.map(s => (
                <tr key={s.ref} class={s.ref === selected ? 'selected' : ''} onMouseDown={() => setSelected(s.ref)} onDblClick={() => call('view', { root, hash: s.hash, ref: s.ref })}>
                  <td class="mono" style={{ width: '1%' }}>
                    {s.ref}
                  </td>
                  <td>
                    {s.branch ? `On ${s.branch}: ` : ''}
                    {s.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!stashes.length && <div class="empty-text">No stashes</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignSelf: 'flex-start' }}>
          <Button disabled={!stash} tip="View selected stash" onClick={() => stash && call('view', { root, hash: stash.hash, ref: stash.ref })}>
            View
          </Button>
          <Button
            disabled={!stash}
            tip="Delete selected stash"
            onClick={async () => stash && setStashes(await call<Stash[]>('drop', { root, ref: stash.ref, message: stash.message }))}
          >
            Drop
          </Button>
          <Button disabled={!stashes.length} tip="Delete all stashes in the repository" onClick={async () => setStashes(await call<Stash[]>('clear', { root }))}>
            Clear
          </Button>
        </div>
      </Row>
      <Row label="As new branch:">
        <input class="text-field" placeholder="" value={branch} onInput={e => setBranch((e.currentTarget as HTMLInputElement).value)} />
      </Row>
      <Checkbox checked={pop} onChange={setPop} label="Pop stash" tip="If selected the stash is dropped after it is applied" disabled={!!branch.trim()} />
      <Checkbox checked={reinstate} onChange={setReinstate} label="Reinstate index" tip="Attempt to reinstate index as well as working tree changes" disabled={!!branch.trim()} />
      </div>
    </DialogFrame>
  );
});
