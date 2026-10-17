import { useMemo, useState } from 'preact/hooks';
import { Button, Checkbox, Radio } from '../../../lib/components';
import { FileIcon, Icon } from '../../../lib/icons';
import { call } from '../../../lib/rpc';
import { DialogFrame, Group, Row } from '../../frame';
import { registerDialog } from '../../registry';
import { ComboField, ComboItem, formatDate } from './widgets';

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ Git Checkout Problem (GitSmartOperationDialog)

registerDialog<{ operation: string; files: string[]; untracked: boolean }>('ops.smartOperation', ({ props, submit, cancel }) => {
  const op = props.operation;
  const Op = cap(op);
  return (
    <DialogFrame
      title={`Git ${Op} Problem`}
      width={560}
      onCancel={cancel}
      onOk={() => submit({ button: 'smart' })}
      buttons={
        <>
          <Button onClick={() => submit({ button: 'dont' })}>Don't {Op}</Button>
          <Button onClick={() => submit({ button: 'force' })} tip={`${Op} and overwrite local changes`}>
            Force {Op}
          </Button>
          <Button primary onClick={() => submit({ button: 'smart' })} tip={`Stash local changes, ${op}, unstash`}>
            Smart {Op}
          </Button>
        </>
      }
    >
      <div style={{ lineHeight: '20px', padding: '2px 0 6px' }}>
        {props.untracked ? (
          <>The following untracked working tree files would be overwritten by {op}.</>
        ) : (
          <>Your local changes to the following files would be overwritten by {op}.</>
        )}
        <br />
        Rebased can stash the changes, {op} and unstash them after that.
      </div>
      <div class="panel-box file-list">
        {props.files.map(f => (
          <div class="tree-row" key={f}>
            <span class="chevron" />
            <FileIcon path={f} />
            <span class="label st-M">{f.slice(f.lastIndexOf('/') + 1)}</span>
            <span class="hint">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
          </div>
        ))}
      </div>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ New branch / rename (GitNewBranchDialog)

export interface NewBranchProps {
  title: string;
  okLabel: string;
  initial: string;
  mode: 'create' | 'rename';
  checkout?: boolean;
  showCheckout?: boolean;
  showOverwrite?: boolean;
  /** Existing local branches, remote branches. */
  locals: string[];
  remotes: string[];
  /** Branch being renamed. */
  renaming?: string;
}

export function validateBranchName(name: string, p: NewBranchProps, overwrite: boolean): string | undefined {
  if (!name.trim()) return 'Specify name for the new branch';
  if (name === 'HEAD') return 'HEAD is a reserved keyword';
  if (
    /(^|\/)\./.test(name) ||
    name.includes('..') ||
    /[\x00-\x20~^:?*[\\\x7f]/.test(name) ||
    name.endsWith('/') ||
    name.endsWith('.lock') ||
    name.endsWith('.') ||
    name.includes('@{') ||
    name.includes('//') ||
    name.startsWith('/') ||
    name.startsWith('-')
  )
    return `Branch name ${name} is not valid`;
  if (name === p.renaming) return undefined;
  if (!overwrite && p.locals.includes(name)) return `Branch name ${name} already exists`;
  if (p.remotes.includes(name)) return `Branch name ${name} conflicts with remote branch with the same name`;
  if (p.locals.some(l => l.startsWith(name + '/'))) return `Branch name ${name} conflicts with local branch directory with the same name`;
  return undefined;
}

registerDialog<NewBranchProps>('ops.newBranch', ({ props, submit, cancel }) => {
  const [name, setName] = useState(props.initial);
  const [checkout, setCheckout] = useState(props.checkout ?? true);
  const [overwrite, setOverwrite] = useState(false);
  const [touched, setTouched] = useState(false);
  const [hostError, setHostError] = useState<string>();
  const exists = props.locals.includes(name) && name !== props.renaming;
  const error = validateBranchName(name, props, overwrite);
  const ok = async () => {
    setTouched(true);
    if (error) return;
    setHostError(await submit({ name, checkout, overwrite }));
  };
  return (
    <DialogFrame
      title={props.title}
      width={480}
      onCancel={cancel}
      onOk={ok}
      okDisabled={!!error && touched}
      error={hostError}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!!error && (touched || !name)}>
            {props.okLabel}
          </Button>
        </>
      }
    >
      <Row label="New branch name:">
        <input
          class={`text-field ${error && (touched || name !== props.initial) ? 'error' : ''}`}
          value={name}
          autofocus
          spellcheck={false}
          onFocus={e => (e.currentTarget as HTMLInputElement).select()}
          onInput={e => {
            setName((e.currentTarget as HTMLInputElement).value.replace(/\s/g, '-'));
            setTouched(true);
          }}
        />
      </Row>
      {error && (touched || name !== props.initial) && <div class="error-text" style={{ marginLeft: '124px', marginTop: '-2px' }}>{exists && props.showOverwrite ? 'Change the name or overwrite existing branch' : error}</div>}
      {(props.showCheckout || props.showOverwrite) && (
        <div style={{ display: 'flex', gap: '16px', marginLeft: '124px' }}>
          {props.showCheckout && <Checkbox checked={checkout} onChange={setCheckout} label="Checkout branch" />}
          {props.showOverwrite && <Checkbox checked={overwrite} onChange={setOverwrite} label="Overwrite existing branch" disabled={!exists && !overwrite} />}
        </div>
      )}
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Tag (GitTagDialog)

registerDialog<{ root: string; repoName: string; currentBranch: string; commit?: string; tags: string[] }>('ops.tag', ({ props, submit, cancel }) => {
  const [name, setName] = useState('');
  const [force, setForce] = useState(false);
  const [commit, setCommit] = useState(props.commit ?? '');
  const [message, setMessage] = useState('');
  const [err, setErr] = useState<string>();
  const exists = props.tags.includes(name);
  const ok = async () => {
    if (!name || (exists && !force)) return;
    setErr(await submit({ name, force, commit, message }));
  };
  return (
    <DialogFrame
      title="Tag"
      width={520}
      onCancel={cancel}
      onOk={ok}
      error={err}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!name || (exists && !force)}>
            Create Tag
          </Button>
        </>
      }
    >
      <Row label="Git root:">
        <span>{props.repoName}</span>
      </Row>
      <Row label="Current branch:">
        <span>{props.currentBranch}</span>
      </Row>
      <Row label="Tag name:">
        <input class={`text-field ${exists && !force ? 'error' : ''}`} value={name} autofocus spellcheck={false} onInput={e => setName((e.currentTarget as HTMLInputElement).value.trim())} data-tip="Enter the new tag name here." />
        <Checkbox checked={force} onChange={setForce} label="Force" tip="Force creation of the tag even if another tag with such name already exists." />
      </Row>
      {exists && !force && <div class="error-text" style={{ marginLeft: '98px' }}>The tag with the same name exists.</div>}
      <Row label="Commit:">
        <input class="text-field mono-text" value={commit} placeholder="HEAD" spellcheck={false} onInput={e => setCommit((e.currentTarget as HTMLInputElement).value)} data-tip="Enter name of commit or object to tag or leave blank to use HEAD." />
      </Row>
      <Row label="Message:" top>
        <textarea class="text-area mono" rows={5} value={message} onInput={e => setMessage((e.currentTarget as HTMLTextAreaElement).value)} data-tip="If the message is not empty, an annotated tag is created." />
      </Row>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Git Reset (GitNewResetDialog)

const RESET_MODES = [
  { id: 'soft', label: 'Soft', desc: "Files won't change, differences will be staged for commit." },
  { id: 'mixed', label: 'Mixed', desc: "Files won't change, differences won't be staged." },
  { id: 'hard', label: 'Hard', desc: 'Files will be reverted to the state of the selected commit.\nWarning: any local changes will be lost.' },
  { id: 'keep', label: 'Keep', desc: 'Files will be reverted to the state of the selected commit,\nbut local changes will be kept intact.' },
];

registerDialog<{ commits: { hash: string; subject: string; author: string; repo: string }[]; branch: string; mode?: string; editable?: boolean }>('ops.reset', ({ props, submit, cancel }) => {
  const [mode, setMode] = useState(props.mode ?? 'mixed');
  const [target, setTarget] = useState(props.commits[0]?.hash ?? 'HEAD');
  const ok = () => submit({ mode, target });
  return (
    <DialogFrame
      title="Git Reset"
      width={540}
      onCancel={cancel}
      onOk={ok}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok}>
            {mode === 'hard' ? 'Hard Reset' : 'Reset'}
          </Button>
        </>
      }
    >
      <div style={{ lineHeight: '20px' }}>
        This will reset the current branch head to the selected commit,
        <br />
        and update the working tree and the index according to the selected mode:
      </div>
      {props.editable ? (
        <Row label="To commit:">
          <input class="text-field mono-text" value={target} autofocus spellcheck={false} onInput={e => setTarget((e.currentTarget as HTMLInputElement).value)} />
        </Row>
      ) : (
        props.commits.map(c => (
          <div class="secondary" key={c.hash} style={{ padding: '4px 0 2px', lineHeight: '18px' }}>
            <span class="mono-text">{c.hash.slice(0, 8)}</span> "{c.subject}" by {c.author}
            {props.commits.length > 1 && <> in {c.repo}</>}
          </div>
        ))
      )}
      <div class="reset-modes">
        {RESET_MODES.map(m => (
          <>
            <Radio name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} label={m.label} />
            <div class="desc" style={{ whiteSpace: 'pre-line' }}>
              {m.desc}
            </div>
          </>
        ))}
      </div>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Commit message editor (reword / squash)

registerDialog<{ title: string; message: string; okLabel?: string; commits?: { hash: string; subject: string }[]; root?: string }>('ops.commitMessage', ({ props, submit, cancel }) => {
  const [message, setMessage] = useState(props.message);
  const ok = () => message.trim() && submit({ message: message.replace(/\s+$/, '') });
  return (
    <DialogFrame
      title={props.title}
      width={620}
      onCancel={cancel}
      onOk={ok}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!message.trim()}>
            {props.okLabel ?? 'OK'}
          </Button>
        </>
      }
      left={<span class="field-hint">Press Ctrl+Enter to apply changes</span>}
    >
      {props.commits && props.commits.length > 1 && (
        <div class="secondary" style={{ marginBottom: '4px' }}>
          {props.commits.length} commits: {props.commits.map(c => c.hash.slice(0, 8)).join(', ')}
        </div>
      )}
      <textarea
        class="text-area mono"
        style={{ height: '220px', width: '100%' }}
        value={message}
        autofocus
        spellcheck={false}
        onInput={e => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
      />
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Push Rejected (GitRejectedPushUpdateDialog)

registerDialog<{ branch: string; hasMerges?: boolean }>('ops.pushRejected', ({ props, submit, cancel }) => {
  const [remember, setRemember] = useState(false);
  return (
    <DialogFrame
      title="Push Rejected"
      width={520}
      onCancel={cancel}
      onOk={() => submit({ button: props.hasMerges ? 'merge' : 'rebase', remember })}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary={!!props.hasMerges} onClick={() => submit({ button: 'merge', remember })}>
            Merge
          </Button>
          <Button primary={!props.hasMerges} onClick={() => submit({ button: 'rebase', remember })}>
            {props.hasMerges ? 'Rebase Anyway' : 'Rebase'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '4px 0 8px', lineHeight: '20px' }}>
        <Icon name="general/questionDialog" size={20} />
        <div>
          Push of the current branch "{props.branch}" was rejected.
          <br />
          Remote changes need to be merged before pushing.
          {props.hasMerges && (
            <>
              <br />
              <br />
              In this case <b>merge is highly recommended</b>, because there are non-pushed merge commits. Rebasing them can lead to problems.
            </>
          )}
        </div>
      </div>
      <Checkbox checked={remember} onChange={setRemember} label="Remember the update method and update silently in the future" />
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Update Project (VcsUpdateDialog / GitUpdateOptionsPanel)

registerDialog<{ method: string; saveChanges: string; repos: string[]; canReset?: boolean }>('ops.update', ({ props, submit, cancel }) => {
  const [method, setMethod] = useState(props.method === 'rebase' ? 'rebase' : 'merge');
  const [save, setSave] = useState(props.saveChanges === 'shelve' ? 'shelve' : 'stash');
  const [dontShow, setDontShow] = useState(false);
  const ok = () => submit({ method, saveChanges: save, dontShow });
  return (
    <DialogFrame
      title="Update Project"
      width={520}
      onCancel={cancel}
      onOk={ok}
      left={
        <>
          {props.canReset && (
            <Button tip="Checks out the corresponding remote branch" onClick={() => submit({ method, saveChanges: save, dontShow: false, button: 'reset' })}>
              Reset to the Remote Branch
            </Button>
          )}
          <Checkbox checked={dontShow} onChange={setDontShow} label="Don't show again" />
        </>
      }
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok}>
            OK
          </Button>
        </>
      }
    >
      {props.repos.length > 1 && <div class="secondary">Update {props.repos.length} repositories: {props.repos.join(', ')}</div>}
      <Group title="Update Type">
        <Radio name="method" checked={method === 'merge'} onChange={() => setMethod('merge')} label="Merge incoming changes into the current branch" />
        <Radio name="method" checked={method === 'rebase'} onChange={() => setMethod('rebase')} label="Rebase the current branch on top of incoming changes" />
      </Group>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Create Patch

registerDialog<{ path: string; count: number }>('ops.createPatch', ({ props, submit, cancel }) => {
  const [file, setFile] = useState(props.path);
  const [reverse, setReverse] = useState(false);
  const [toClipboard, setToClipboard] = useState(false);
  const ok = () => submit({ path: file, reverse, clipboard: toClipboard });
  return (
    <DialogFrame
      title="Create Patch"
      width={600}
      onCancel={cancel}
      onOk={ok}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!toClipboard && !file}>
            OK
          </Button>
        </>
      }
    >
      <div class="secondary">{props.count === 1 ? '1 change' : `${props.count} changes`}</div>
      <Row label="File:">
        <input class="text-field" value={file} disabled={toClipboard} spellcheck={false} onInput={e => setFile((e.currentTarget as HTMLInputElement).value)} />
        <button
          class="action-button"
          data-tip="Browse…"
          disabled={toClipboard}
          onClick={async () => {
            const p = await call<string | null>('browse', file);
            if (p) setFile(p);
          }}
        >
          <Icon name="inline/browse" />
        </button>
      </Row>
      <div style={{ marginLeft: '98px', display: 'flex', flexDirection: 'column' }}>
        <Checkbox checked={toClipboard} onChange={setToClipboard} label="Copy patch to clipboard instead of saving to a file" />
        <Checkbox checked={reverse} onChange={setReverse} label="Reverse patch" />
      </div>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Branch Was Not Fully Merged

registerDialog<{ branch: string; base: string; commits: { hash: string; subject: string; author: string; date: number }[] }>('ops.notFullyMerged', ({ props, submit, cancel }) => (
  <DialogFrame
    title="Branch Was Not Fully Merged"
    width={620}
    onCancel={cancel}
    onOk={() => submit({ button: 'delete' })}
    buttons={
      <>
        <Button onClick={cancel}>Cancel</Button>
        <Button primary onClick={() => submit({ button: 'delete' })}>
          Delete
        </Button>
      </>
    }
  >
    <div style={{ lineHeight: '20px' }}>
      The branch <b>{props.branch}</b> was not fully merged to <b>{props.base}</b>.
      <br />
      Below is the list of unmerged commits.
    </div>
    <div class="panel-box file-list" style={{ maxHeight: '260px' }}>
      {props.commits.map(c => (
        <div class="tree-row" key={c.hash}>
          <span class="subject" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.subject}
          </span>
          <span class="secondary">{c.author}</span>
          <span class="secondary" style={{ width: '120px', textAlign: 'right' }}>
            {formatDate(c.date)}
          </span>
        </div>
      ))}
    </div>
  </DialogFrame>
));

// ------------------------------------------------------------------ Checkout Tag or Revision

registerDialog<{ refs: ComboItem[] }>('ops.checkoutRevision', ({ props, submit, cancel }) => {
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<string>();
  const items = useMemo(() => props.refs, [props.refs]);
  const ok = async () => ref.trim() && setErr(await submit({ ref: ref.trim() }));
  return (
    <DialogFrame
      title="Checkout Tag or Revision"
      width={480}
      onCancel={cancel}
      onOk={ok}
      error={err}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!ref.trim()}>
            Checkout
          </Button>
        </>
      }
    >
      <div>Enter reference (branch, tag) name or commit hash:</div>
      <ComboField value={ref} onChange={setRef} items={items} autofocus placeholder="Reference or hash" />
    </DialogFrame>
  );
});
