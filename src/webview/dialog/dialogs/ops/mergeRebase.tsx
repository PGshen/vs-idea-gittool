import { useState } from 'preact/hooks';
import { Button } from '../../../lib/components';
import { t } from '../../../lib/l10n';
import { DialogFrame, Row } from '../../frame';
import { registerDialog } from '../../registry';
import { ComboField, ComboItem, OptionChips, OptionDef, OptionsLink } from './widgets';

interface RepoChoice {
  root: string;
  name: string;
  branch: string;
}

function RepoRow({ repos, root, setRoot }: { repos: RepoChoice[]; root: string; setRoot: (r: string) => void }) {
  if (repos.length < 2) return null;
  return (
    <Row label={t('Repository:')}>
      <select class="combo" value={root} onChange={e => setRoot((e.currentTarget as HTMLSelectElement).value)}>
        {repos.map(r => (
          <option value={r.root} key={r.root}>
            {r.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

// ------------------------------------------------------------------ Merge (GitMergeDialog)

export const MERGE_OPTIONS: OptionDef[] = [
  { id: 'no-ff', flag: '--no-ff', description: t('Create a merge commit even if it can be fast-forwarded'), excludes: ['ff-only', 'squash'] },
  { id: 'ff-only', flag: '--ff-only', description: t('Merge only if it can be fast-forwarded'), excludes: ['no-ff', 'squash', 'commit-msg', 'no-commit'] },
  { id: 'squash', flag: '--squash', description: t('Create a single commit for all merged changes'), excludes: ['no-ff', 'ff-only', 'commit-msg'] },
  { id: 'commit-msg', flag: '-m', description: t('Specify a message for the merge commit'), excludes: ['ff-only', 'squash', 'no-commit'] },
  { id: 'no-commit', flag: '--no-commit', description: t('Do not commit the merge result'), excludes: ['ff-only', 'commit-msg'] },
  { id: 'no-verify', flag: '--no-verify', description: t('Bypass the pre-merge and commit message hooks') },
  { id: 'allow-unrelated-histories', flag: '--allow-unrelated-histories', description: t('Allow merging histories that do not share a common ancestor.') },
];

export interface MergeProps {
  repos: RepoChoice[];
  root: string;
  /** Branches per root: unmerged local and remote branches. */
  branches: Record<string, ComboItem[]>;
  initialBranch?: string;
}

registerDialog<MergeProps>('ops.merge', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const [branch, setBranch] = useState(props.initialBranch ?? '');
  const [options, setOptions] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const repo = props.repos.find(r => r.root === root) ?? props.repos[0];
  const items = props.branches[root] ?? [];
  const known = items.some(i => i.value === branch);
  const ok = async () => {
    if (!branch.trim()) {
      setError(t('The merge branch should be selected.'));
      return;
    }
    setError(await submit({ root, branch: branch.trim(), options, message }));
  };
  return (
    <DialogFrame
      title={t('Merge into {0}', repo.branch)}
      width={580}
      onCancel={cancel}
      onOk={ok}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok} disabled={!branch.trim()}>
            {t('Merge')}
          </Button>
        </>
      }
    >
      <div class="dialog-header-line">
        <span class="spacer" style={{ flex: 1 }} />
        <OptionsLink title={t('Add Merge Options')} options={MERGE_OPTIONS} selected={options} onChange={setOptions} />
      </div>
      <RepoRow repos={props.repos} root={root} setRoot={setRoot} />
      <Row label={<span class="mono-text">merge</span>}>
        <ComboField value={branch} onChange={setBranch} items={items} placeholder={t('Specify branch')} autofocus error={!!branch && !known && /\s/.test(branch)} />
      </Row>
      {options.includes('commit-msg') && (
        <Row label={<span class="mono-text">-m</span>} top>
          <textarea class="text-area mono" rows={3} value={message} placeholder={t('Commit message')} onInput={e => setMessage((e.currentTarget as HTMLTextAreaElement).value)} />
        </Row>
      )}
      <OptionChips options={MERGE_OPTIONS} selected={options} onRemove={id => setOptions(options.filter(o => o !== id))} />
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Pull (GitPullDialog)

export const PULL_OPTIONS: OptionDef[] = [
  { id: 'rebase', flag: '--rebase', description: t('Rebase the current branch on top of incoming changes'), excludes: ['ff-only', 'no-ff', 'squash', 'no-commit'] },
  { id: 'ff-only', flag: '--ff-only', description: t('Merge only if it can be fast-forwarded'), excludes: ['rebase', 'no-ff', 'squash'] },
  { id: 'no-ff', flag: '--no-ff', description: t('Create a merge commit even if it can be fast-forwarded'), excludes: ['rebase', 'ff-only', 'squash'] },
  { id: 'squash', flag: '--squash', description: t('Create a single commit for all pulled changes'), excludes: ['rebase', 'ff-only', 'no-ff'] },
  { id: 'no-commit', flag: '--no-commit', description: t('Merge, but do not commit the result'), excludes: ['rebase'] },
  { id: 'no-verify', flag: '--no-verify', description: t('Bypass the pre-merge and commit message hooks') },
];

export interface PullProps {
  repos: RepoChoice[];
  root: string;
  remotes: Record<string, string[]>;
  /** remote -> branches of that remote (without the remote prefix). */
  remoteBranches: Record<string, Record<string, string[]>>;
  defaultRemote: Record<string, string>;
  defaultBranch: Record<string, string>;
  options?: string[];
}

registerDialog<PullProps>('ops.pull', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const remotes = props.remotes[root] ?? [];
  const [remote, setRemote] = useState(props.defaultRemote[root] ?? remotes[0] ?? '');
  const [branch, setBranch] = useState(props.defaultBranch[root] ?? '');
  const [options, setOptions] = useState<string[]>(props.options ?? []);
  const [error, setError] = useState<string>();
  const repo = props.repos.find(r => r.root === root) ?? props.repos[0];
  const items: ComboItem[] = (props.remoteBranches[root]?.[remote] ?? []).map(b => ({ value: b, icon: 'general/vcs' }));
  const ok = async () => {
    if (!branch.trim()) {
      setError(t('Select a branch to pull'));
      return;
    }
    setError(await submit({ root, remote, branch: branch.trim(), options }));
  };
  return (
    <DialogFrame
      title={t('Pull to {0}', repo.branch)}
      width={580}
      onCancel={cancel}
      onOk={ok}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok} disabled={!remote || !branch.trim()}>
            {t('Pull')}
          </Button>
        </>
      }
    >
      <div class="dialog-header-line">
        <span style={{ flex: 1 }} />
        <OptionsLink title={t('Add Pull Options')} options={PULL_OPTIONS} selected={options} onChange={setOptions} />
      </div>
      <RepoRow repos={props.repos} root={root} setRoot={r => (setRoot(r), setRemote(props.defaultRemote[r] ?? ''), setBranch(props.defaultBranch[r] ?? ''))} />
      <Row label={<span class="mono-text">pull</span>}>
        <select class="combo" style={{ flex: 'none', width: '140px' }} value={remote} onChange={e => setRemote((e.currentTarget as HTMLSelectElement).value)}>
          {remotes.map(r => (
            <option value={r} key={r}>
              {r}
            </option>
          ))}
        </select>
        <ComboField value={branch} onChange={setBranch} items={items} placeholder={t('Branch')} autofocus />
      </Row>
      <OptionChips options={PULL_OPTIONS} selected={options} onRemove={id => setOptions(options.filter(o => o !== id))} />
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Rebase (GitRebaseDialog)

export const REBASE_OPTIONS: OptionDef[] = [
  { id: 'onto', flag: '--onto', description: t('Specify a new base for the rebased commits'), excludes: ['root'] },
  { id: 'interactive', flag: '--interactive', description: t('Edit commits before rebasing') },
  { id: 'update-refs', flag: '--update-refs', description: t('Auto-update branches pointing to rebased commits') },
  { id: 'rebase-merges', flag: '--rebase-merges', description: t('Recreate commits topology') },
  { id: 'keep-empty', flag: '--keep-empty', description: t('Do not remove empty commits during rebase') },
  { id: 'root', flag: '--root', description: t('Rebase all commits in the branch'), excludes: ['onto'] },
  { id: 'switch', flag: t('Select another branch to rebase'), description: t('Select another branch to rebase') },
];

export interface RebaseProps {
  repos: RepoChoice[];
  root: string;
  refs: Record<string, ComboItem[]>;
  locals: Record<string, ComboItem[]>;
  initialUpstream?: string;
  initialOptions?: string[];
}

registerDialog<RebaseProps>('ops.rebase', ({ props, submit, cancel }) => {
  const [root, setRoot] = useState(props.root);
  const [options, setOptions] = useState<string[]>(props.initialOptions ?? []);
  const [upstream, setUpstream] = useState(props.initialUpstream ?? '');
  const [onto, setOnto] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState<string>();
  const repo = props.repos.find(r => r.root === root) ?? props.repos[0];
  const refs = props.refs[root] ?? [];
  const hasOnto = options.includes('onto');
  const isRoot = options.includes('root');
  const ok = async () => {
    if (hasOnto && !onto.trim()) return setError(t('Select a new base'));
    if (!isRoot && !upstream.trim()) return setError(hasOnto ? t('Select an upstream') : t('Select a new base'));
    if (options.includes('switch') && !branch.trim()) return setError(t('Select a branch to switch to'));
    setError(await submit({ root, upstream: upstream.trim(), onto: onto.trim(), branch: branch.trim(), options }));
  };
  return (
    <DialogFrame
      title={t('Rebase')}
      width={640}
      onCancel={cancel}
      onOk={ok}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok}>
            {t('Rebase')}
          </Button>
        </>
      }
    >
      <div class="dialog-header-line">
        <span class="secondary">
          {t('Rebase')} <b style={{ color: 'var(--fg)' }}>{options.includes('switch') ? branch || '…' : repo.branch}</b>
        </span>
        <span style={{ flex: 1 }} />
        <OptionsLink title={t('Add Rebase Options')} options={REBASE_OPTIONS} selected={options} onChange={setOptions} />
      </div>
      <RepoRow repos={props.repos} root={root} setRoot={setRoot} />
      <Row label={<span class="mono-text">rebase</span>}>
        {hasOnto && (
          <>
            <span class="mono-text secondary">--onto</span>
            <ComboField value={onto} onChange={setOnto} items={refs} placeholder={t('new base (branch or hash)')} autofocus />
          </>
        )}
        {!isRoot && <ComboField value={upstream} onChange={setUpstream} items={refs} placeholder={hasOnto ? t('old base (branch or hash)') : t('branch or hash')} autofocus={!hasOnto} />}
        {isRoot && <span class="mono-text secondary">--root</span>}
        {options.includes('switch') && <ComboField value={branch} onChange={setBranch} items={props.locals[root] ?? []} placeholder={t('source branch')} />}
      </Row>
      <OptionChips options={REBASE_OPTIONS.filter(o => o.id !== 'switch')} selected={options.filter(o => o !== 'switch')} onRemove={id => setOptions(options.filter(o => o !== id))} />
    </DialogFrame>
  );
});
