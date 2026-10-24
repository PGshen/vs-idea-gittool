import { useEffect, useMemo, useState } from 'preact/hooks';
import { Button, Checkbox } from '../../../lib/components';
import { Icon } from '../../../lib/icons';
import { t } from '../../../lib/l10n';
import { call } from '../../../lib/rpc';
import { DialogFrame, Row } from '../../frame';
import { registerDialog } from '../../registry';
import { ComboField, ComboItem, Hint } from './widgets';

interface RepoData {
  root: string;
  name: string;
  current?: string;
  refs: { name: string; type: 'local' | 'remote' | 'HEAD' | 'stash'; worktree?: string }[];
  tags: string[];
}

interface Props {
  repos: RepoData[];
  root: string;
  ref: string;
  parent: string;
}

// ------------------------------------------------------------------ New Worktree (GitWorkingTreeDialog)

registerDialog<Props>('ops.newWorktree', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const repo = props.repos.find(r => r.root === root) ?? props.repos[0];
  const [ref, setRef] = useState(props.ref);
  const [newBranchOn, setNewBranchOn] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [parent, setParent] = useState(props.parent);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const items = useMemo<ComboItem[]>(
    () => [
      ...repo.refs
        .filter(r => r.type === 'local')
        .map(r => ({ value: r.name, icon: 'general/vcs', group: t('Local'), hint: r.worktree ? r.worktree : undefined })),
      ...repo.refs.filter(r => r.type === 'remote').map(r => ({ value: r.name, icon: 'general/vcs', group: t('Remote') })),
      ...repo.tags.map(tag => ({ value: tag, icon: 'nodes/tag', group: t('Tags') })),
    ],
    [repo],
  );
  const checkedOutElsewhere = repo.refs.find(r => r.type === 'local' && r.name === ref && r.worktree);
  const isTag = repo.tags.includes(ref);

  // The project name follows the branch until the user edits it (suggestProjectName).
  useEffect(() => {
    if (nameTouched) return;
    const base = (newBranchOn && newBranch.trim() ? newBranch : ref).replace(/^.*\//, '').replace(/[^A-Za-z0-9 _.-]/g, '-');
    setName(base ? `${repo.name}-${base}` : '');
  }, [ref, newBranch, newBranchOn, root]);
  // A tag or a branch checked out in another worktree needs a new branch.
  useEffect(() => {
    if (isTag || checkedOutElsewhere) setNewBranchOn(true);
  }, [ref]);

  const target = parent && name ? joinPath(parent, name) : '';
  const ok = async () => {
    setBusy(true);
    setError(await submit({ root, ref, newBranch: newBranchOn ? newBranch.trim() : undefined, name: name.trim(), parent: parent.trim() }));
    setBusy(false);
  };
  return (
    <DialogFrame
      title={t('New Worktree')}
      width={620}
      onCancel={cancel}
      onOk={ok}
      okDisabled={busy}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok} disabled={busy || !ref}>
            {busy ? t('Creating worktree…') : t('Create & Open Worktree')}
          </Button>
        </>
      }
    >
      {props.repos.length > 1 && (
        <Row label={t('Repository:')}>
          <select
            class="combo"
            value={root}
            onChange={e => {
              const r = (e.currentTarget as HTMLSelectElement).value;
              setRoot(r);
              setRef(props.repos.find(x => x.root === r)?.current ?? '');
            }}
          >
            {props.repos.map(r => (
              <option value={r.root}>{r.root}</option>
            ))}
          </select>
        </Row>
      )}
      <Row label={t('From branch:')}>
        <ComboField value={ref} onChange={setRef} items={items} placeholder={t('Select branch')} autofocus error={!ref && !!error} />
      </Row>
      {checkedOutElsewhere && !newBranchOn && <Hint>{t('Selected branch is already checked out in another worktree')}</Hint>}
      <Row label={<Checkbox checked={newBranchOn} onChange={setNewBranchOn} label={t('New branch:')} />}>
        <input class="text-field" value={newBranch} disabled={!newBranchOn} spellcheck={false} onInput={e => setNewBranch((e.currentTarget as HTMLInputElement).value)} />
      </Row>
      <Row label={t('Project name:')}>
        <input
          class="text-field"
          value={name}
          spellcheck={false}
          onInput={e => {
            setName((e.currentTarget as HTMLInputElement).value);
            setNameTouched(true);
          }}
        />
      </Row>
      <Row label={t('Location:')}>
        <input class="text-field" value={parent} spellcheck={false} onInput={e => setParent((e.currentTarget as HTMLInputElement).value)} />
        <button
          class="action-button"
          data-tip={t('Worktree Location')}
          onClick={async () => {
            const p = await call<string | null>('browse', { current: parent });
            if (p) setParent(p);
          }}
        >
          <Icon name="inline/browse" />
        </button>
      </Row>
      {target && (
        <div class="comment" style={{ marginLeft: '98px', marginTop: 0 }}>
          {t('The worktree will be created in:')}
          <br />
          {target}
        </div>
      )}
    </DialogFrame>
  );
});

function joinPath(parent: string, name: string) {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}
