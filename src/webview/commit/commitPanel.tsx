import { useEffect, useRef, useState } from 'preact/hooks';
import { ActionButton, Button, Checkbox } from '../lib/components';
import { Icon } from '../lib/icons';
import { shortcutKey } from '../lib/keys';
import { t } from '../lib/l10n';
import { anchorBelow, MenuEntry, showMenu, showPopup } from '../lib/menu';
import { boot, call, on, persist, persisted, send } from '../lib/rpc';
import { CommitOptionsState, CommitViewState } from '../../shared/commitProtocol';

interface AmendCandidate {
  hash: string;
  subject: string;
  author: string;
  date: number;
  root: string;
}

/**
 * The commit message panel of the Commit tool window: Amend checkbox with the commit to amend,
 * commit message history, the message editor and the Commit / Commit and Push… buttons with options.
 */
export function CommitPanel({ state, included, commitTrigger, visible }: { state: CommitViewState; included: Set<string>; commitTrigger: number; visible: boolean }) {
  const [message, setMessage] = useState<string>(() => persisted('message', boot.initial.draft ?? ''));
  const [amend, setAmend] = useState(false);
  const [amendTarget, setAmendTarget] = useState<AmendCandidate | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Guards against a second commit before `busy` re-renders, e.g. Ctrl+Alt+K handled here and by the keybinding.
  const committing = useRef(false);
  const draftBeforeAmend = useRef('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<number>();

  const updateMessage = (m: string) => {
    setMessage(m);
    setError(undefined);
    persist('message', m);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => send('saveDraft', { message: m }), 500);
  };

  useEffect(() => on('focusMessage', () => textRef.current?.focus()), []);
  useEffect(
    () =>
      on('setMessage', (m: string) => {
        updateMessage(m);
        textRef.current?.focus();
      }),
    [],
  );
  useEffect(() => on('commitAndPush', () => doCommit(true)), [message, amend, amendTarget, included]);
  useEffect(() => {
    if (commitTrigger) textRef.current?.focus();
  }, [commitTrigger]);
  useEffect(() => {
    if (visible) textRef.current?.focus({ preventScroll: true } as FocusOptions);
  }, []);

  const toggleAmend = async (value: boolean, target?: AmendCandidate) => {
    if (value) {
      if (!amend) draftBeforeAmend.current = message;
      setAmend(true);
      setAmendTarget(target);
      const msg = await call<string>('amendMessage', { root: target?.root, hash: target?.hash });
      updateMessage(msg);
    } else {
      setAmend(false);
      setAmendTarget(undefined);
      updateMessage(draftBeforeAmend.current);
    }
  };

  const doCommit = async (push: boolean) => {
    if (committing.current) return;
    committing.current = true;
    setBusy(true);
    try {
      const r = await call<{ ok: boolean; error?: string }>('commit', { message, amend, amendHash: amendTarget?.hash, push, keys: [...included] });
      if (r.ok) {
        setAmend(false);
        setAmendTarget(undefined);
        draftBeforeAmend.current = '';
        updateMessage('');
      } else if (r.error) setError(r.error);
    } catch {
      // Error notification is shown by the host.
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };

  const showHistory = (anchor: Element) => {
    const history = state.messageHistory;
    const entries: MenuEntry[] = history.length
      ? history.map(m => ({ label: m.split('\n')[0], hint: m.includes('\n') ? '…' : undefined, action: () => updateMessage(m) }))
      : [{ label: t('No messages'), disabled: true }];
    showMenu(entries, anchorBelow(anchor), { title: t('Commit Message History') });
  };

  const chooseAmendTarget = async (anchor: Element) => {
    const list = await call<AmendCandidate[]>('amendCandidates');
    const entries: MenuEntry[] = list.map((c, i) => ({
      label: c.subject,
      hint: `${c.hash.slice(0, 8)} ${c.author}`,
      checked: amend && (amendTarget ? amendTarget.hash === c.hash : i === 0),
      action: () => toggleAmend(true, i === 0 ? undefined : c),
    }));
    showMenu(entries.length ? entries : [{ label: t('No commits'), disabled: true }], anchorBelow(anchor), { title: t('Commit to Amend') });
  };

  const showOptions = (anchor: Element) => {
    showPopup(close => <OptionsPopup options={state.options} close={close} />, { ...anchorBelow(anchor, true), y: anchor.getBoundingClientRect().top - 4, flipHeight: 0 }, { class: 'options-container' });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = shortcutKey(e);
    if (ctrl && e.key === 'Enter') {
      e.preventDefault();
      void doCommit(false);
    } else if (ctrl && e.altKey && key === 'k') {
      e.preventDefault();
      void doCommit(true);
    } else if (ctrl && key === 'm') {
      e.preventDefault();
      showHistory(textRef.current!);
    } else if (ctrl && key === 'o') {
      e.preventDefault();
      const gear = document.querySelector('.commit-buttons .action-button');
      if (gear) showOptions(gear);
    } else if (e.altKey && key === 'm') {
      e.preventDefault();
      void toggleAmend(!amend);
    } else if (ctrl && key === 'k') {
      e.preventDefault();
      void doCommit(false);
    }
  };

  const merging = state.repos.some(r => r.operation === 'merge');
  const commitLabel = amend ? t('Amend Commit') : t('Commit');
  const commitAndPushLabel = amend ? t('Amend Commit and Push…') : t('Commit and Push…');
  const amendLabel = amendTarget ? amendTarget.subject : t('last commit');
  const emptyRepo = state.repos.length > 0 && state.repos.every(r => !r.headHash);

  return (
    <div class="commit-panel" onKeyDown={onKeyDown}>
      <div class="amend-row">
        <Checkbox checked={amend} disabled={emptyRepo || merging} onChange={v => toggleAmend(v)} label={t('Amend')} tip={t('Merge this commit with the previous one (Alt+M)')} />
        <span
          class="amend-target"
          data-tip={t('Choose the commit to amend')}
          onClick={e => !emptyRepo && chooseAmendTarget(e.currentTarget as Element)}
          style={emptyRepo ? { color: 'var(--fg-disabled)' } : undefined}
        >
          {amendLabel}
          <Icon name="general/chevronDown" size={14} />
        </span>
        <span style={{ width: '4px' }} />
        <ActionButton icon="general/history" tip={t('Commit Message History')} shortcut="Ctrl+M" onClick={e => showHistory(e.currentTarget as Element)} />
      </div>
      <div class="message-box">
        <textarea
          ref={textRef}
          class="text-area"
          placeholder={t('Commit Message')}
          aria-label={t('Commit Message')}
          spellcheck={false}
          value={message}
          onInput={e => updateMessage((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>
      {error && <div class="message-error">{error}</div>}
      <div class="commit-buttons">
        <Button onClick={() => doCommit(false)} disabled={busy} tip="Ctrl+Enter">
          {commitLabel}
        </Button>
        <Button onClick={() => doCommit(true)} disabled={busy} tip="Ctrl+Alt+K">
          {commitAndPushLabel}
        </Button>
        <span class="spacer" />
        {busy && <span class="spinner" />}
        <ActionButton icon="general/settings" tip={t('Show Commit Options')} shortcut="Ctrl+O" onClick={e => showOptions(e.currentTarget as Element)} />
      </div>
    </div>
  );
}

function OptionsPopup({ options, close }: { options: CommitOptionsState; close: () => void }) {
  const [o, setO] = useState(options);
  const [defaultAuthor, setDefaultAuthor] = useState('');
  useEffect(() => {
    call<string>('defaultAuthor').then(setDefaultAuthor);
  }, []);
  const update = (p: Partial<CommitOptionsState>) => {
    const next = { ...o, ...p };
    setO(next);
    send('setOptions', p);
  };
  return (
    <div class="options-popup" onKeyDown={e => e.key === 'Enter' && close()}>
      <div class="section">Git</div>
      <div class="row">
        <label for="commit-author">{t('Author:')}</label>
        <input
          id="commit-author"
          class="text-field"
          placeholder={defaultAuthor}
          value={o.author}
          onChange={e => update({ author: (e.currentTarget as HTMLInputElement).value.trim() })}
        />
      </div>
      <Checkbox checked={o.signOff} onChange={v => update({ signOff: v })} label={t('Sign-off commit')} tip={t('Adds the following line at the end of the commit message:\nSigned-off by: {0}', defaultAuthor)} />
      <Checkbox checked={o.extraMoveCommit} onChange={v => update({ extraMoveCommit: v })} label={t('Create extra commit with file movements')} />
    </div>
  );
}
