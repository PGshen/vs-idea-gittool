import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Change } from '../../../../shared/types';
import { buildDirectoryTree, Button, Split, Tree, TreeNode, walkTree } from '../../../lib/components';
import { fileIconName, Icon } from '../../../lib/icons';
import { shortcutKey } from '../../../lib/keys';
import { t } from '../../../lib/l10n';
import { anchorAt, anchorBelow, showMenu, showPopup } from '../../../lib/menu';
import { call } from '../../../lib/rpc';
import { DialogFrame } from '../../frame';
import { registerDialog } from '../../registry';
import { formatDate } from './widgets';

type Action = 'pick' | 'edit' | 'reword' | 'squash' | 'fixup' | 'drop';

interface RebaseCommit {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: number;
}

interface Entry {
  hash: string;
  subject: string;
  action: Action;
  /** New full message (reword, or combined squash message on the group root). */
  message?: string;
}

export interface InteractiveRebaseProps {
  root: string;
  /** Commits in todo order (oldest first). */
  commits: RebaseCommit[];
  base?: string;
}

const ACTIONS: { id: Action; label: string; key: string; icon?: string; tip: string }[] = [
  { id: 'pick', label: t('Pick'), key: 'Alt+P', icon: 'vcs/revert', tip: t('Pick') },
  { id: 'edit', label: t('Stop to Edit'), key: 'Alt+E', icon: 'run/pause', tip: t('Stop to Edit') },
  { id: 'reword', label: t('Reword'), key: 'Alt+R', tip: t('Reword') },
  { id: 'squash', label: t('Squash'), key: 'Alt+S', tip: t('Squash') },
  { id: 'fixup', label: t('Fixup'), key: 'Alt+F', tip: t('Fixup') },
  { id: 'drop', label: t('Drop'), key: 'Alt+D', tip: t('Drop') },
];

const ACTION_NAMES: Record<Action, string> = { pick: t('Pick'), edit: t('Edit'), reword: t('Reword'), squash: t('Squash'), fixup: t('Fixup'), drop: t('Drop') };

function prettySquash(messages: string[]) {
  const seen = new Set<string>();
  return messages
    .map(m => m.replace(/^(fixup|squash|amend)! /, '').trim())
    .filter(m => !seen.has(m) && (seen.add(m), true))
    .join('\n\n\n');
}

registerDialog<InteractiveRebaseProps>('ops.interactiveRebase', ({ props, submit, cancel }) => {
  const byHash = useMemo(() => new Map(props.commits.map(c => [c.hash, c])), [props.commits]);
  const initial = (): Entry[] => props.commits.map(c => ({ hash: c.hash, subject: c.subject, action: 'pick' as Action }));
  // Todo order (oldest first); the table shows it reversed, newest on top like the log.
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(props.commits.length ? [props.commits[props.commits.length - 1].hash] : []));
  const [lead, setLead] = useState<string | undefined>(props.commits[props.commits.length - 1]?.hash);
  const [rewording, setRewording] = useState<{ hash: string; text: string } | null>(null);
  const [modified, setModified] = useState(false);
  const [error, setError] = useState<string>();
  const tableRef = useRef<HTMLDivElement>(null);
  const display = [...entries].reverse();

  const change = (next: Entry[]) => {
    setEntries(next);
    setModified(true);
  };

  const selectedIdx = () => entries.map((e, i) => (selection.has(e.hash) ? i : -1)).filter(i => i >= 0);

  const setAction = (action: Action) => {
    const idx = selectedIdx();
    if (!idx.length) return;
    let next = entries.map(e => ({ ...e }));
    if (action === 'squash' || action === 'fixup') {
      if (idx.length === 1) {
        // Squash into the previous (older) commit.
        const i = idx[0];
        if (i === 0) return;
        next[i].action = action;
        const root = groupRoot(next, i);
        if (action === 'squash') {
          const group = groupMembers(next, root);
          const msg = prettySquash(group.filter(g => next[g].action !== 'fixup').map(g => next[g].message ?? fullMessage(next[g].hash)));
          next[root].message = msg;
          setEntries(next);
          setModified(true);
          setRewording({ hash: next[root].hash, text: msg });
          return;
        }
      } else {
        // Combine the selected commits into the oldest one.
        const [first, ...rest] = idx;
        const moved = rest.map(i => ({ ...next[i], action }));
        next = next.filter((_, i) => !rest.includes(i));
        next.splice(first + 1, 0, ...moved);
        if (action === 'squash') {
          const msg = prettySquash([next[first], ...moved].map(e => e.message ?? fullMessage(e.hash)));
          next[first].message = msg;
          change(next);
          setRewording({ hash: next[first].hash, text: msg });
          return;
        }
      }
    } else if (action === 'reword') {
      const i = idx[idx.length - 1];
      const e = next[i];
      if (e.action === 'drop' || e.action === 'fixup' || e.action === 'squash') e.action = 'pick';
      setRewording({ hash: e.hash, text: e.message ?? fullMessage(e.hash) });
      setEntries(next);
      return;
    } else {
      for (const i of idx) {
        next[i].action = action;
        if (action === 'pick') delete next[i].message;
      }
    }
    change(next);
  };

  const fullMessage = (hash: string) => {
    const c = byHash.get(hash);
    return c ? c.body || c.subject : '';
  };

  const move = (dir: -1 | 1) => {
    // dir is in display terms: -1 = up (newer), which is +1 in todo order.
    const idx = selectedIdx();
    if (!idx.length) return;
    const todoDir = -dir;
    const next = [...entries];
    const sorted = todoDir > 0 ? [...idx].reverse() : idx;
    for (const i of sorted) {
      const j = i + todoDir;
      if (j < 0 || j >= next.length || idx.includes(j)) return;
      [next[i], next[j]] = [next[j], next[i]];
    }
    change(next);
  };

  const applyReword = () => {
    if (!rewording) return;
    const next = entries.map(e => (e.hash === rewording.hash ? { ...e, message: rewording.text.replace(/\s+$/, ''), action: e.action === 'pick' ? ('reword' as Action) : e.action } : e));
    setRewording(null);
    change(next);
    tableRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (rewording) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const i = display.findIndex(x => x.hash === lead);
      const j = Math.max(0, Math.min(display.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const h = display[j].hash;
      setLead(h);
      if (e.shiftKey) setSelection(new Set([...selection, h]));
      else setSelection(new Set([h]));
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const k = shortcutKey(e);
    const map: Record<string, Action> = { p: 'pick', e: 'edit', r: 'reword', s: 'squash', f: 'fixup', d: 'drop', delete: 'drop', backspace: 'drop' };
    if (map[k]) {
      e.preventDefault();
      e.stopPropagation();
      setAction(map[k]);
    } else if (e.key === 'F2') {
      e.preventDefault();
      setAction('reword');
    }
  };

  const start = async () => {
    if (rewording) applyReword();
    if (entries.every(e => e.action === 'drop')) {
      setError(t('Cannot drop all commits'));
      return;
    }
    if (entries[0]?.action === 'squash' || entries[0]?.action === 'fixup') {
      setError(t('Cannot squash or fixup the first commit'));
      return;
    }
    setError(await submit({ entries }));
  };

  const doCancel = () => {
    if (modified) {
      showPopup(
        close => (
          <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '320px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <Icon name="general/questionDialog" size={20} />
              <div>
                <b>{t('Cancel Rebase')}</b>
                <div style={{ marginTop: '4px' }}>{t('Discard changes and cancel rebase?')}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Button onClick={close}>{t('Continue Rebasing')}</Button>
              <Button primary onClick={() => (close(), cancel())}>
                {t('Discard')}
              </Button>
            </div>
          </div>
        ),
        { x: window.innerWidth / 2 - 160, y: window.innerHeight / 2 - 60 },
      );
    } else cancel();
  };

  const contextMenu = (e: MouseEvent) =>
    showMenu(
      [
        ...ACTIONS.map(a => ({ label: a.label, shortcut: a.key, icon: a.icon, action: () => setAction(a.id) })),
        { separator: true as const },
        { label: t('View Git Commands'), action: () => showCommands() },
      ],
      anchorAt(e),
    );

  const showCommands = () =>
    showPopup(
      () => (
        <pre class="mono" style={{ margin: 0, padding: '8px 14px', userSelect: 'text', maxWidth: '640px', whiteSpace: 'pre-wrap' }}>
          {entries.map(e => `${e.action === 'reword' ? 'reword' : e.action} ${e.hash.slice(0, 8)} ${e.subject}`).join('\n')}
        </pre>
      ),
      { x: 40, y: 80 },
    );

  const leadEntry = entries.find(e => e.hash === lead);
  const squashGroupDepth = (i: number) => (entries[i].action === 'squash' || entries[i].action === 'fixup' ? 1 : 0);

  return (
    <DialogFrame
      title={t('Rebasing Commits')}
      width="min(1100px, calc(100vw - 32px))"
      height="min(640px, calc(100vh - 32px))"
      resizable
      onCancel={doCancel}
      onOk={start}
      error={error}
      buttons={
        <>
          <Button onClick={doCancel}>{t('Cancel')}</Button>
          <Button primary onClick={start}>
            {t('Start Rebasing')}
          </Button>
        </>
      }
    >
      <div class="panel-box" style={{ flex: 1, minHeight: 0 }}>
        <Split persistKey="irebase" initial={620}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div class="irebase-toolbar">
              <button class="action-button" data-tip={t('Move Up')} data-shortcut="Alt+Up" onClick={() => move(-1)}>
                <Icon name="general/moveUp" />
              </button>
              <button class="action-button" data-tip={t('Move Down')} data-shortcut="Alt+Down" onClick={() => move(1)}>
                <Icon name="general/moveDown" />
              </button>
              <button class="action-button" data-tip={t('Pick')} data-shortcut="Alt+P" onClick={() => setAction('pick')}>
                <Icon name="vcs/revert" />
              </button>
              <button class="action-button" data-tip={t('Stop to Edit')} data-shortcut="Alt+E" onClick={() => setAction('edit')}>
                <Icon name="run/pause" />
              </button>
              <span class="toolbar-separator" />
              <button class="toolbar-button-text" data-tip={t('Reword')} data-shortcut="Alt+R" onClick={() => setAction('reword')}>
                {t('Reword')}
              </button>
              <span class="btn-split">
                <button class="toolbar-button-text" data-tip={t('Squash')} data-shortcut="Alt+S" onClick={() => setAction('squash')}>
                  {t('Squash')}
                </button>
                <button
                  class="toolbar-button-text"
                  style={{ padding: '0 2px' }}
                  onClick={e => showMenu([{ label: t('Fixup'), shortcut: 'Alt+F', action: () => setAction('fixup') }], anchorBelow(e.currentTarget as Element))}
                >
                  <Icon name="general/chevronDown" size={12} />
                </button>
              </span>
              <button class="toolbar-button-text" data-tip={t('Drop')} data-shortcut="Alt+D" onClick={() => setAction('drop')}>
                {t('Drop')}
              </button>
              <span style={{ flex: 1 }} />
              {modified && (
                <span
                  class="link"
                  style={{ marginRight: '8px' }}
                  onClick={() => {
                    setEntries(initial());
                    setModified(false);
                    setRewording(null);
                  }}
                >
                  {t('Reset')}
                </span>
              )}
            </div>
            <div class="irebase-table" tabIndex={0} ref={tableRef} onKeyDown={onKey} autofocus>
              {display.map(e => {
                const i = entries.indexOf(e);
                const sel = selection.has(e.hash);
                const c = byHash.get(e.hash)!;
                return (
                  <div
                    key={e.hash}
                    class={`irebase-row ${sel ? 'selected' : ''} ${e.action}`}
                    onMouseDown={ev => {
                      if (ev.button === 2 && sel) return;
                      if (ev.ctrlKey || ev.metaKey) {
                        const s = new Set(selection);
                        if (s.has(e.hash)) s.delete(e.hash);
                        else s.add(e.hash);
                        setSelection(s);
                      } else if (ev.shiftKey && lead) {
                        const a = display.findIndex(x => x.hash === lead);
                        const b = display.indexOf(e);
                        setSelection(new Set(display.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.hash)));
                        return;
                      } else setSelection(new Set([e.hash]));
                      setLead(e.hash);
                    }}
                    onDblClick={() => setAction('reword')}
                    onContextMenu={ev => {
                      ev.preventDefault();
                      contextMenu(ev);
                    }}
                  >
                    <span class={`irebase-node ${e.action}`} style={{ marginLeft: `${squashGroupDepth(i) * 0}px` }}>
                      {e.action === 'edit' ? (
                        <span class="action-icon">
                          <Icon name="run/pause" />
                        </span>
                      ) : e.action === 'drop' ? (
                        <span class="action-icon">
                          <Icon name="general/remove" />
                        </span>
                      ) : (
                        <span class="dot" />
                      )}
                    </span>
                    {rewording?.hash === e.hash ? (
                      <input
                        class="reword"
                        value={rewording.text.split('\n')[0]}
                        autofocus
                        ref={el => el && document.activeElement !== el && !el.dataset.f && ((el.dataset.f = '1'), el.focus(), el.select())}
                        onInput={ev => setRewording({ hash: e.hash, text: (ev.currentTarget as HTMLInputElement).value + rewording.text.slice(rewording.text.split('\n')[0].length) })}
                        onKeyDown={ev => {
                          ev.stopPropagation();
                          if (ev.key === 'Enter') {
                            ev.preventDefault();
                            applyReword();
                          } else if (ev.key === 'Escape') {
                            ev.preventDefault();
                            setRewording(null);
                            tableRef.current?.focus();
                          }
                        }}
                      />
                    ) : (
                      <span class="subject">{e.message !== undefined ? e.message.split('\n')[0] : e.subject}</span>
                    )}
                    {e.action !== 'pick' && <span class="irebase-action">{ACTION_NAMES[e.action]}</span>}
                    <span class="secondary" style={{ width: '120px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.author}
                    </span>
                    <span class="secondary" style={{ width: '110px', textAlign: 'right' }}>
                      {formatDate(c.date)}
                    </span>
                  </div>
                );
              })}
            </div>
            {rewording && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <textarea
                  class="text-area mono irebase-reword-area"
                  rows={5}
                  value={rewording.text}
                  onInput={ev => setRewording({ ...rewording, text: (ev.currentTarget as HTMLTextAreaElement).value })}
                  onKeyDown={ev => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                      ev.preventDefault();
                      applyReword();
                    } else if (ev.key === 'Escape') {
                      ev.preventDefault();
                      setRewording(null);
                    }
                  }}
                />
                <span class="field-hint">{t('Press Ctrl+Enter to apply changes')}</span>
              </div>
            )}
          </div>
          <CommitDetails root={props.root} entry={leadEntry} commit={lead ? byHash.get(lead) : undefined} />
        </Split>
      </div>
    </DialogFrame>
  );
});

function groupRoot(entries: Entry[], i: number) {
  let r = i;
  while (r > 0 && (entries[r].action === 'squash' || entries[r].action === 'fixup')) r--;
  return r;
}

function groupMembers(entries: Entry[], root: number) {
  const out = [root];
  for (let j = root + 1; j < entries.length && (entries[j].action === 'squash' || entries[j].action === 'fixup'); j++) out.push(j);
  return out;
}

function CommitDetails({ root, entry, commit }: { root: string; entry?: Entry; commit?: RebaseCommit }) {
  const [changes, setChanges] = useState<Change[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!commit) return;
    let stale = false;
    call<Change[]>('commitChanges', { root, hashes: [commit.hash] }).then(c => {
      if (stale) return;
      setChanges(c);
      const nodes = tree(c);
      const exp = new Set<string>();
      walkTree(nodes, n => n.children && exp.add(n.key));
      setExpanded(exp);
    });
    return () => {
      stale = true;
    };
  }, [commit?.hash]);
  const nodes = useMemo(() => tree(changes), [changes]);
  if (!commit) return <div class="empty-text">{t('Select commit to view changes')}</div>;
  const message = entry?.message ?? commit.body ?? commit.subject;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Tree
          nodes={nodes}
          expanded={expanded}
          onExpandedChange={setExpanded}
          selection={sel}
          onSelectionChange={setSel}
          onOpen={n => n.data && call('showDiff', { change: n.data, hash: commit.hash })}
          emptyText={t('No changes')}
        />
      </div>
      <div class="details-pane">
        <div style={{ fontWeight: 600, marginBottom: '6px' }}>{message.split('\n')[0]}</div>
        {message.includes('\n') && <div style={{ marginBottom: '6px' }}>{message.split('\n').slice(1).join('\n').trim()}</div>}
        <div class="secondary">
          <span class="mono-text">{commit.hash.slice(0, 8)}</span> {t('{0} on {1}', commit.author, formatDate(commit.date))}
        </div>
      </div>
    </div>
  );
}

function tree(changes: Change[]): TreeNode[] {
  return buildDirectoryTree(
    changes,
    c => ({ key: `f:${c.path}`, label: c.path.slice(c.path.lastIndexOf('/') + 1), text: c.path, icon: fileIconName(c.path), labelClass: `st-${c.status}`, data: c }),
    'ir:',
  );
}
