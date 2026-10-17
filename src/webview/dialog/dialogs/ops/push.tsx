import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Change } from '../../../../shared/types';
import { buildDirectoryTree, Button, Checkbox, SplitButton, Tree, TreeNode, walkTree } from '../../../lib/components';
import { fileIconName, Icon } from '../../../lib/icons';
import { anchorBelow, showMenu } from '../../../lib/menu';
import { call } from '../../../lib/rpc';
import { DialogFrame } from '../../frame';
import { registerDialog } from '../../registry';
import { formatDate } from './widgets';

export interface PushCommit {
  hash: string;
  subject: string;
  body?: string;
  author: string;
  authorEmail?: string;
  date: number;
}

export interface PushRepo {
  root: string;
  name: string;
  source: string;
  remote: string;
  target: string;
  remotes: string[];
  /** remote -> branch names on that remote. */
  remoteBranches: Record<string, string[]>;
  commits: PushCommit[];
  /** Target does not exist on the remote yet. */
  isNew: boolean;
  hasUpstream: boolean;
  checked: boolean;
  /** Reason the repository cannot be pushed (empty repository, detached HEAD without target). */
  problem?: string;
}

export interface PushProps {
  title: string;
  repos: PushRepo[];
  tagsMode: 'none' | 'all' | 'current';
  runHooks: boolean;
  forceAllowed: boolean;
}

registerDialog<PushProps>('ops.push', ({ props, submit, cancel }) => {
  const [repos, setRepos] = useState<PushRepo[]>(props.repos);
  const [selected, setSelected] = useState<string>(() => (props.repos[0]?.commits[0] ? `${props.repos[0].root}|${props.repos[0].commits[0].hash}` : props.repos[0]?.root ?? ''));
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set([selected]));
  const [editing, setEditing] = useState<{ root: string; what: 'remote' | 'target' } | null>(null);
  const [pushTags, setPushTags] = useState(props.tagsMode !== 'none');
  const [tagsMode, setTagsMode] = useState<'all' | 'current'>(props.tagsMode === 'current' ? 'current' : 'all');
  const [runHooks, setRunHooks] = useState(props.runHooks);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fileSel, setFileSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const multi = repos.length > 1;

  // Rows of the left tree: repo nodes and their commits.
  const rows = useMemo(() => {
    const out: { key: string; repo: PushRepo; commit?: PushCommit }[] = [];
    for (const r of repos) {
      out.push({ key: r.root, repo: r });
      for (const c of r.commits) out.push({ key: `${r.root}|${c.hash}`, repo: r, commit: c });
    }
    return out;
  }, [repos]);

  const selectedCommits = rows.filter(r => r.commit && multiSel.has(r.key));
  const selectedRepoRows = rows.filter(r => !r.commit && multiSel.has(r.key));

  useEffect(() => {
    const byRoot = new Map<string, string[]>();
    const add = (root: string, hash: string) => byRoot.set(root, [...(byRoot.get(root) ?? []), hash]);
    for (const r of selectedCommits) add(r.repo.root, r.commit!.hash);
    for (const r of selectedRepoRows) for (const c of r.repo.commits) add(r.repo.root, c.hash);
    if (byRoot.size === 0) {
      setChanges([]);
      return;
    }
    let stale = false;
    setLoadingChanges(true);
    Promise.all([...byRoot].map(([root, hashes]) => call<Change[]>('commitChanges', { root, hashes })))
      .then(res => {
        if (stale) return;
        const all = res.flat();
        setChanges(all);
        const exp = new Set<string>();
        const nodes = buildTree(all);
        walkTree(nodes, n => n.children && exp.add(n.key));
        setExpanded(exp);
      })
      .finally(() => !stale && setLoadingChanges(false));
    return () => {
      stale = true;
    };
  }, [multiSel, repos]);

  const fileNodes = useMemo(() => buildTree(changes), [changes]);

  const update = (root: string, patch: Partial<PushRepo>) => setRepos(rs => rs.map(r => (r.root === root ? { ...r, ...patch } : r)));

  const changeTarget = async (r: PushRepo, remote: string, target: string) => {
    setEditing(null);
    update(r.root, { remote, target });
    const res = await call<{ commits: PushCommit[]; isNew: boolean }>('commits', { root: r.root, remote, target, source: r.source });
    update(r.root, { remote, target, commits: res.commits, isNew: res.isNew });
  };

  const totalCommits = repos.filter(r => r.checked || !multi).reduce((s, r) => s + r.commits.length, 0);
  const canPush = repos.some(r => (r.checked || !multi) && !r.problem && (r.commits.length > 0 || r.isNew || pushTags));

  const doPush = async (force?: 'lease' | 'force') => {
    if (busy) return;
    setBusy(true);
    const err = await submit({
      repos: repos.filter(r => (r.checked || !multi) && !r.problem).map(r => ({ root: r.root, remote: r.remote, target: r.target, source: r.source, setUpstream: !r.hasUpstream, isNew: r.isNew, count: r.commits.length })),
      force,
      tags: pushTags ? tagsMode : 'none',
      runHooks,
    });
    setBusy(false);
    setError(err);
  };

  const onKey = (e: KeyboardEvent) => {
    const i = rows.findIndex(r => r.key === selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) {
        setSelected(n.key);
        setMultiSel(new Set([n.key]));
      }
    } else if (e.key === ' ' && multi && rows[i] && !rows[i].commit) {
      e.preventDefault();
      update(rows[i].repo.root, { checked: !rows[i].repo.checked });
    }
  };

  const detailsCommit = selectedCommits.length === 1 ? selectedCommits[0].commit : undefined;

  return (
    <DialogFrame
      title={props.title}
      width="min(1000px, calc(100vw - 32px))"
      height="min(640px, calc(100vh - 32px))"
      resizable
      onCancel={cancel}
      onOk={() => canPush && doPush()}
      okDisabled={!canPush || busy}
      error={error}
      left={
        <>
          <Checkbox checked={pushTags} onChange={setPushTags} label="Push tags:" />
          <select class="combo" style={{ height: '24px' }} disabled={!pushTags} value={tagsMode} onChange={e => setTagsMode((e.currentTarget as HTMLSelectElement).value as 'all' | 'current')}>
            <option value="all">All</option>
            <option value="current">Current Branch</option>
          </select>
          <span style={{ width: '12px' }} />
          <Checkbox checked={runHooks} onChange={setRunHooks} label="Run Git hooks" />
        </>
      }
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          {props.forceAllowed ? (
            <SplitButton
              primary
              onClick={() => doPush()}
              disabled={!canPush || busy}
              menu={() => [
                { label: 'Push', action: () => doPush() },
                { label: 'Force Push', action: () => doPush('lease') },
              ]}
            >
              {busy ? 'Pushing…' : 'Push'}
            </SplitButton>
          ) : (
            <Button primary onClick={() => doPush()} disabled={!canPush || busy}>
              Push
            </Button>
          )}
        </>
      }
    >
      <div class="push-body">
        <div class="push-left" tabIndex={0} ref={leftRef} onKeyDown={onKey}>
          {rows.map(row => {
            const sel = multiSel.has(row.key);
            if (!row.commit) {
              const r = row.repo;
              return (
                <div
                  key={row.key}
                  class={`push-row ${sel ? 'selected' : ''}`}
                  style={{ fontWeight: 600 }}
                  onMouseDown={e => select(row.key, e)}
                >
                  {multi && (
                    <input
                      type="checkbox"
                      class="tree-check"
                      checked={r.checked}
                      onClick={e => {
                        e.stopPropagation();
                        update(r.root, { checked: !r.checked });
                      }}
                    />
                  )}
                  {multi && <span style={{ fontWeight: 600 }}>{r.name}:</span>}
                  <span class="push-target" style={{ fontWeight: 'normal' }}>
                    <span>{r.source}</span>
                    <span class="secondary">&nbsp;→&nbsp;</span>
                    {r.problem ? (
                      <span class="error-text">{r.problem}</span>
                    ) : editing?.root === r.root && editing.what === 'target' ? (
                      <TargetEditor
                        initial={r.target}
                        options={r.remoteBranches[r.remote] ?? []}
                        onDone={v => (v && v !== r.target ? changeTarget(r, r.remote, v) : setEditing(null))}
                      />
                    ) : (
                      <>
                        <span
                          class="editable"
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => {
                            if (r.remotes.length < 2) return;
                            showMenu(
                              r.remotes.map(rem => ({ label: rem, checked: rem === r.remote, action: () => changeTarget(r, rem, r.target) })),
                              anchorBelow(e.currentTarget as Element),
                            );
                          }}
                        >
                          {r.remote}
                        </span>
                        <span>&nbsp;:&nbsp;</span>
                        <span class="editable" onMouseDown={e => e.stopPropagation()} onClick={() => setEditing({ root: r.root, what: 'target' })}>
                          {r.target}
                        </span>
                        {r.isNew && <span class="push-tag" style={{ marginLeft: '6px' }}>{r.hasUpstream ? 'New' : 'New & Upstream'}</span>}
                      </>
                    )}
                  </span>
                </div>
              );
            }
            const c = row.commit;
            return (
              <div key={row.key} class={`push-row ${sel ? 'selected' : ''}`} style={{ paddingLeft: '22px' }} onMouseDown={e => select(row.key, e)} data-tip={`${c.hash.slice(0, 8)} ${c.author} ${formatDate(c.date)}\n\n${c.body ?? c.subject}`}>
                <Icon name="vcs/commit" />
                <span class="subject">{c.subject}</span>
                <span class="meta">{c.author}</span>
                <span class="meta" style={{ width: '110px', textAlign: 'right' }}>
                  {formatDate(c.date)}
                </span>
              </div>
            );
          })}
          {totalCommits === 0 && repos.every(r => !r.isNew) && <div class="empty-text">No commits to push. Everything is up to date.</div>}
        </div>
        <div class="push-right">
          <div class="toolbar" style={{ minHeight: '30px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span class="secondary">{changes.length ? `${changes.length} ${changes.length === 1 ? 'file' : 'files'}` : ''}</span>
            <span class="spacer" />
            <button
              class="action-button"
              data-tip="Show Diff"
              data-shortcut="Ctrl+D"
              disabled={fileSel.size === 0}
              onClick={() => openDiff()}
            >
              <Icon name="vcs/diff" />
            </button>
          </div>
          {loadingChanges && changes.length === 0 ? (
            <div class="empty-text">Loading…</div>
          ) : (
            <Tree
              nodes={fileNodes}
              expanded={expanded}
              onExpandedChange={setExpanded}
              selection={fileSel}
              onSelectionChange={s => setFileSel(s)}
              onOpen={n => n.data?.change && call('showDiff', { change: n.data.change, hash: n.data.change.hash })}
              emptyText={multiSel.size ? 'No differences' : 'No commits selected'}
            />
          )}
          {detailsCommit && (
            <div class="details-pane">
              <div style={{ fontWeight: 600, marginBottom: '6px' }}>{detailsCommit.subject}</div>
              {detailsCommit.body && detailsCommit.body !== detailsCommit.subject && <div style={{ marginBottom: '6px' }}>{detailsCommit.body.split('\n').slice(1).join('\n').trim()}</div>}
              <div class="secondary">
                <span class="mono-text">{detailsCommit.hash.slice(0, 8)}</span> {detailsCommit.author}
                {detailsCommit.authorEmail && <> &lt;{detailsCommit.authorEmail}&gt;</>} on {formatDate(detailsCommit.date)}
              </div>
            </div>
          )}
        </div>
      </div>
    </DialogFrame>
  );

  function select(key: string, e: MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(multiSel);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setMultiSel(next);
    } else if (e.shiftKey) {
      const a = rows.findIndex(r => r.key === selected);
      const b = rows.findIndex(r => r.key === key);
      setMultiSel(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.key)));
    } else {
      setMultiSel(new Set([key]));
      setSelected(key);
    }
  }

  function openDiff() {
    for (const k of fileSel) {
      let found: TreeNode | undefined;
      walkTree(fileNodes, n => n.key === k && (found = n));
      const ch = found?.data?.change;
      if (ch) call('showDiff', { change: ch, hash: ch.hash });
    }
  }
});

function TargetEditor({ initial, options, onDone }: { initial: string; options: string[]; onDone: (v: string | undefined) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <>
      <input
        ref={ref}
        value={v}
        list="push-target-options"
        spellcheck={false}
        onInput={e => setV((e.currentTarget as HTMLInputElement).value)}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            onDone(v.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone(undefined);
          }
        }}
        onBlur={() => onDone(v.trim())}
      />
      <datalist id="push-target-options">
        {options.map(o => (
          <option value={o} key={o} />
        ))}
      </datalist>
    </>
  );
}

type PushChange = Change & { hash: string };

function buildTree(changes: Change[]): TreeNode[] {
  return buildDirectoryTree(
    changes as PushChange[],
    c => ({
      key: `file:${c.root}:${c.hash}:${c.path}`,
      label: c.path.slice(c.path.lastIndexOf('/') + 1),
      text: c.path,
      icon: fileIconName(c.path),
      labelClass: `st-${c.status === '?' ? 'A' : c.status}`,
      hint: c.oldPath ? `renamed from ${c.oldPath}` : undefined,
      data: { change: c },
    }),
    'push:',
  );
}
