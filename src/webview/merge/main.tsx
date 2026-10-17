import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '../lib/base.css';
import './merge.css';
import { ActionButton, Button, Separator, Toolbar } from '../lib/components';
import { Icon } from '../lib/icons';
import { anchorBelow, MenuEntry, showMenu } from '../lib/menu';
import { boot, call, on, send, theme } from '../lib/rpc';
import { statusText, unprocessedMessage } from '../../shared/mergeModel';
import { CompareMode, MergeInit, MergeSettings, TitleParts } from '../../shared/mergeProtocol';
import { MergeController } from './controller';

const init = boot.initial as MergeInit;

function Title({ parts }: { parts: TitleParts }) {
  return (
    <span class="mg-title-text">
      {parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

function App() {
  const ctl = useRef<MergeController>();
  if (!ctl.current) ctl.current = new MergeController(init, init.settings, theme.dark);
  const c = ctl.current;
  const [, setTick] = useState(0);
  const [settings, setSettings] = useState<MergeSettings>(init.settings);
  const hosts = { left: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };
  const ctrls = { left: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };
  const d1 = useRef<SVGSVGElement>(null);
  const d2 = useRef<SVGSVGElement>(null);
  const compareRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    c.mount(
      { left: hosts.left.current!, result: hosts.result.current!, right: hosts.right.current! },
      { left: ctrls.left.current!, result: ctrls.result.current!, right: ctrls.right.current! },
      [d1.current!, d2.current!],
    );
    const off = c.onChange(() => setTick(t => t + 1));
    const offTheme = on('themeChanged', (d: { dark: boolean }) => c.setDark(d.dark));
    return () => {
      off();
      offTheme();
    };
  }, []);

  // Clicks on the gutter controls (rendered as HTML by the controller).
  const onCtrlClick = (e: MouseEvent) => {
    const b = (e.target as Element).closest('.mg-ctrl-btn') as HTMLElement | null;
    if (!b) return;
    const i = +b.dataset.i!;
    const side = b.dataset.side as 'left' | 'right';
    const action = b.dataset.action;
    if (action === 'apply') c.apply(i, side);
    else if (action === 'ignore') c.ignore(i, side);
    else if (action === 'magic') c.magic(i);
    c.views.result.focus();
  };

  const s = c.views ? c.stats : { changes: 0, conflicts: 0 };
  const done = s.changes === 0 && s.conflicts === 0;

  const saveSettings = (next: MergeSettings) => {
    setSettings(next);
    send('saveSettings', next);
  };

  const finish = async () => {
    if (!done) {
      const ok = await call<boolean>('ask', { title: 'Apply Changes', message: unprocessedMessage(s), yes: 'Apply Changes and Mark Resolved', no: 'Continue Merge' });
      if (!ok) return;
    }
    await call('apply', { text: c.resultText() });
  };

  const cancel = async () => {
    if (c.modified) {
      const ok = await call<boolean>('ask', { title: 'Cancel File Merge', message: 'Are you sure you want to exit without applying changes?', yes: 'Yes', no: 'No' });
      if (!ok) return;
    }
    send('close');
  };

  const accept = (side: 'left' | 'right') => call('accept', { side });

  const compare = (mode: CompareMode) => send('compare', { mode, result: c.views.result.state.doc.toString() });

  const compareMenu = (): MenuEntry[] => [
    { separator: true, label: 'Compare Contents' },
    { label: 'Left and Middle', icon: 'diff/compare4LeftMiddle', action: () => compare('left-result') },
    { label: 'Middle and Right', icon: 'diff/compare4MiddleRight', action: () => compare('result-right') },
    { label: 'Left and Right', icon: 'diff/compare4LeftRight', action: () => compare('left-right') },
    { label: 'Base and Left', icon: 'diff/compare4LeftBottom', action: () => compare('base-left') },
    { label: 'Base and Middle', icon: 'diff/compare4MiddleBottom', action: () => compare('base-result') },
    { label: 'Base and Right', icon: 'diff/compare4RightBottom', action: () => compare('base-right') },
  ];

  const changeIgnore = async (ignore: MergeSettings['ignore']) => {
    if (ignore === settings.ignore) return;
    if (c.modified) {
      const ok = await call<boolean>('ask', {
        title: 'Restart Merge',
        message: 'Changing highlighting requires the file merge restart. Discard unsaved changes and restart merge anyway?',
        yes: 'Discard Changes and Restart Merge',
        no: 'Continue Merge',
      });
      if (!ok) return;
    }
    const next = { ...settings, ignore };
    saveSettings(next);
    c.restart(next);
    setTick(t => t + 1);
  };

  const settingsMenu = (): MenuEntry[] => [
    { label: 'Synchronize Scrolling', checked: settings.syncScroll, action: () => saveSettings((c.settings = { ...settings, syncScroll: !settings.syncScroll })) },
    { separator: true, label: 'Highlighting' },
    ...(
      [
        ['words', 'Highlight Words'],
        ['lines', 'Highlight Lines'],
        ['none', 'Do Not Highlight'],
      ] as const
    ).map(([h, label]) => ({
      label,
      checked: settings.highlight === h,
      action: () => {
        saveSettings({ ...settings, highlight: h });
        c.setHighlight(h);
      },
    })),
    { separator: true, label: 'Ignore' },
    ...(
      [
        ['none', 'Do Not Ignore'],
        ['trim', 'Trim Whitespaces'],
        ['whitespace', 'Ignore Whitespaces'],
      ] as const
    ).map(([p, label]) => ({ label, checked: settings.ignore === p, action: () => void changeIgnore(p) })),
    { separator: true },
    {
      label: 'Automatically Apply Non-Conflicting Changes',
      checked: settings.autoApply,
      action: () => saveSettings((c.settings = { ...settings, autoApply: !settings.autoApply })),
    },
  ];

  const revert = async () => {
    const ok = await call<boolean>('ask', {
      title: 'Confirm Revert',
      message: 'All changes will be reverted. The file will return to its original conflicted state.',
      yes: 'Revert',
      no: 'Cancel',
    });
    if (ok) c.revertAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.popup')) return;
      if (e.key === 'F7') {
        e.preventDefault();
        c.navigate(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void finish();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const ready = !!c.views;
  return (
    <div class="mg-root">
      <Toolbar class="mg-toolbar">
        <ActionButton icon="general/up" tip="Previous Difference" shortcut="Shift+F7" disabled={!ready || done} onClick={() => c.navigate(-1)} />
        <ActionButton icon="general/down" tip="Next Difference" shortcut="F7" disabled={!ready || done} onClick={() => c.navigate(1)} />
        <button ref={compareRef} class="action-button" data-tip="Compare Contents" onClick={() => showMenu(compareMenu(), anchorBelow(compareRef.current!))}>
          <Icon name="vcs/diff" />
          <span class="dropdown-mark" />
        </button>
        <Separator />
        <span class="mg-toolbar-label">Apply non-conflicting changes:</span>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('left')} data-tip="Apply Non-Conflicting Changes from the Left Side" onClick={() => c.applyNonConflicting('left')}>
          <Icon name="diff/applyNotConflictsLeft" />
          Left
        </button>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('all')} data-tip="Apply All Non-Conflicting Changes" onClick={() => c.applyNonConflicting('all')}>
          <Icon name="diff/applyNotConflicts" />
          All
        </button>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('right')} data-tip="Apply Non-Conflicting Changes from the Right Side" onClick={() => c.applyNonConflicting('right')}>
          <Icon name="diff/applyNotConflictsRight" />
          Right
        </button>
        <Separator />
        <ActionButton icon="diff/magicResolveToolbar" tip="Resolve Simple Conflicts" disabled={!ready || !c.hasResolvable()} onClick={() => c.resolveSimpleConflicts()} />
        <ActionButton icon="diff/revert@14x14" tip="Revert Conflict Resolution" disabled={!ready || !c.modified} onClick={() => void revert()} />
        <span class="spacer" />
        <span class={`mg-status ${done ? 'done' : ''}`}>
          {done ? (
            <>
              All changes have been processed.{' '}
              <a class="link" onClick={() => void finish()}>
                Save changes and finish merging
              </a>
            </>
          ) : (
            statusText(s)
          )}
        </span>
        <ActionButton icon="general/settings" tip="Settings" menu={settingsMenu} />
      </Toolbar>
      <div class="mg-titles">
        <div class="mg-title">
          <Title parts={init.titles.left} />
        </div>
        <div class="mg-title-gap" />
        <div class="mg-title">
          <Title parts={init.titles.result} />
        </div>
        <div class="mg-title-gap" />
        <div class="mg-title">
          <Title parts={init.titles.right} />
        </div>
      </div>
      <div class="mg-panes" onClick={onCtrlClick}>
        <div class="mg-pane mg-left">
          <div class="mg-host" ref={hosts.left} />
          <div class="mg-ctrl mg-ctrl-left" ref={ctrls.left} />
        </div>
        <svg class="mg-divider" ref={d1} />
        <div class="mg-pane mg-result">
          <div class="mg-ctrl mg-ctrl-result" ref={ctrls.result} />
          <div class="mg-host" ref={hosts.result} />
        </div>
        <svg class="mg-divider" ref={d2} />
        <div class="mg-pane mg-right">
          <div class="mg-ctrl mg-ctrl-right" ref={ctrls.right} />
          <div class="mg-host" ref={hosts.right} />
        </div>
      </div>
      <div class="mg-south">
        <Button onClick={() => void accept('left')}>Accept Left</Button>
        <Button onClick={() => void accept('right')}>Accept Right</Button>
        <span class="spacer" />
        <Button onClick={() => void cancel()}>Cancel</Button>
        <Button primary onClick={() => void finish()}>
          Apply Changes
        </Button>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
