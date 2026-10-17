import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '../lib/base.css';
import './merge.css';
import { ActionButton, Button, Separator, Toolbar } from '../lib/components';
import { Icon } from '../lib/icons';
import { anchorAt, anchorBelow, MenuEntry, showMenu } from '../lib/menu';
import { boot, call, on, send, theme } from '../lib/rpc';
import { iterativeUnprocessedMessage, Side, statusText, unprocessedMessage } from '../../shared/mergeModel';
import { CompareMode, MergeFinish, MergeInit, MergeResult, MergeSettings, TitleParts } from '../../shared/mergeProtocol';
import { MergeController, Pane } from './controller';

const init = boot.initial as MergeInit;

function Title({ parts }: { parts: TitleParts }) {
  return (
    <span class="mg-title-text">
      {parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

interface Ask {
  title: string;
  message: string;
  yes: string;
  no: string;
  icon?: 'warning' | 'question';
}

function App() {
  const ctl = useRef<MergeController>();
  if (!ctl.current) ctl.current = new MergeController(init, init.settings, theme.dark);
  const c = ctl.current;
  const [, setTick] = useState(0);
  const [settings, setSettings] = useState<MergeSettings>(init.settings);
  const [balloon, setBalloon] = useState(false);
  const hosts = { left: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), right: useRef<HTMLDivElement>(null) };
  const d1 = useRef<SVGSVGElement>(null);
  const d2 = useRef<SVGSVGElement>(null);
  const compareRef = useRef<HTMLButtonElement>(null);
  const wasDone = useRef(false);
  const finished = useRef(false);

  useEffect(() => {
    c.mount({ left: hosts.left.current!, result: hosts.result.current!, right: hosts.right.current! }, [d1.current!, d2.current!]);
    wasDone.current = c.stats.changes === 0 && c.stats.conflicts === 0;
    let progressTimer = 0;
    const off = c.onChange(() => {
      setTick(t => t + 1);
      // The host keeps the latest progress: closing the tab acts as "Cancel" / "Save and Close".
      clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => send('progress', { result: 'CANCEL', lines: c.resultLines(), states: c.states, contentModified: c.contentModified } satisfies MergeFinish), 150);
      // MergeThreesideViewer.onChangeResolved: "All changes have been processed" balloon.
      const s = c.stats;
      const done = s.changes === 0 && s.conflicts === 0;
      if (done && !wasDone.current) setBalloon(true);
      if (!done) setBalloon(false);
      wasDone.current = done;
    });
    const offTheme = on('themeChanged', (d: { dark: boolean }) => c.setDark(d.dark));
    return () => {
      off();
      offTheme();
    };
  }, []);

  const s = c.views ? c.stats : { changes: 0, conflicts: 0 };
  const done = s.changes === 0 && s.conflicts === 0;

  const saveSettings = (next: MergeSettings) => {
    setSettings(next);
    c.settings = next;
    send('saveSettings', next);
  };

  const ask = (a: Ask) => call<boolean>('ask', a);

  const finish = async (result: MergeResult) => {
    if (finished.current) return;
    const payload = (): MergeFinish => ({ result, lines: c.resultLines(), states: c.states, contentModified: c.contentModified });
    if (result === 'RESOLVED') {
      const st = c.stats;
      if (st.changes > 0 || st.conflicts > 0) {
        const ok = init.iterative
          ? await ask({ title: 'Unprocessed Changes', message: iterativeUnprocessedMessage(st.conflicts, st.changes), yes: 'Save Current Result', no: 'Back to Resolving', icon: 'warning' })
          : await ask({ title: 'Apply Changes', message: unprocessedMessage(st), yes: 'Apply Changes and Mark Resolved', no: 'Continue Merge' });
        if (!ok) return;
        c.markAllResolved();
      }
    } else if (result === 'LEFT' || result === 'RIGHT') {
      const action = result === 'LEFT' ? 'Accept Left' : 'Accept Right';
      if (c.contentModified) {
        const ok = await ask({
          title: action,
          message: `There are unsaved changes in the result file. Discard changes and ${action.toLowerCase()} anyway?`,
          yes: `Discard Changes and ${action}`,
          no: 'Continue Merge',
        });
        if (!ok) return;
      }
      c.acceptSide(result === 'LEFT' ? 'left' : 'right');
    } else if (!init.iterative && c.contentModified) {
      const ok = await ask({
        title: 'Cancel Merge',
        message: 'There are unsaved changes in the result file. Discard changes and cancel merge anyway?',
        yes: 'Discard Changes and Cancel Merge',
        no: 'Continue Merge',
      });
      if (!ok) return;
    }
    finished.current = true;
    await call('finish', payload());
  };

  const compare = (mode: CompareMode) => send('compare', { mode, result: c.views.result.state.doc.toString() });

  const compareMenu = (): MenuEntry[] => [
    { separator: true, label: 'Compare Contents' },
    { label: 'Left and Middle', icon: 'diff/compare4LeftMiddle', action: () => compare('left-result') },
    { label: 'Right and Middle', icon: 'diff/compare4MiddleRight', action: () => compare('result-right') },
    { label: 'Left and Right', icon: 'diff/compare4LeftRight', action: () => compare('left-right') },
    { label: 'Base and Left', icon: 'diff/compare4LeftBottom', action: () => compare('base-left') },
    { label: 'Base and Result', icon: 'diff/compare4MiddleBottom', action: () => compare('base-result') },
    { label: 'Base and Right', icon: 'diff/compare4RightBottom', action: () => compare('base-right') },
  ];

  const changeIgnore = async (ignore: MergeSettings['ignore']) => {
    if (ignore === settings.ignore) return;
    if (c.contentModified) {
      const ok = await ask({
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

  const toggleCollapse = () => {
    const next = { ...settings, collapseUnchanged: !settings.collapseUnchanged };
    saveSettings(next);
    c.setCollapse(next.collapseUnchanged);
  };
  const toggleSync = () => saveSettings({ ...settings, syncScroll: !settings.syncScroll });

  /** The gear: editor settings and the diff settings (ignore / highlighting policy). */
  const settingsMenu = (): MenuEntry[] => [
    { label: 'Synchronize Scrolling', icon: 'actions/synchronizeScrolling', checked: settings.syncScroll, action: toggleSync },
    {
      label: 'Automatically Apply Non-Conflicting Changes',
      checked: settings.autoApply,
      action: () => saveSettings({ ...settings, autoApply: !settings.autoApply }),
    },
    { separator: true, label: 'Ignore' },
    ...(
      [
        ['none', 'Do Not Ignore'],
        ['trim', 'Trim Whitespaces'],
        ['whitespace', 'Ignore Whitespaces'],
      ] as const
    ).map(([p, label]) => ({ label, checked: settings.ignore === p, action: () => void changeIgnore(p) })),
    { separator: true, label: 'Highlighting' },
    ...(
      [
        ['lines', 'Highlight Lines'],
        ['words', 'Highlight Words'],
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
  ];

  const revert = async () => {
    const ok = await ask({
      title: 'Confirm Revert',
      message: 'All changes will be reverted. The file will return to its original conflicted state.',
      yes: 'Revert',
      no: 'Cancel',
      icon: 'question',
    });
    if (ok) c.revertAll();
  };

  // Gutter operations, folded fragments and the editor context menus.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      const op = t.closest('.mg-op') as HTMLElement | null;
      if (op) {
        e.preventDefault();
        e.stopPropagation();
        const i = +op.dataset.i!;
        const action = op.dataset.action;
        const side = op.dataset.side as Side;
        const resolve = e.ctrlKey || e.metaKey;
        if (action === 'apply') c.apply(i, side, resolve);
        else if (action === 'ignore') c.ignore(i, side, resolve);
        else if (action === 'resolve') c.resolve(i);
        return;
      }
      const fold = t.closest('.mg-fold') as HTMLElement | null;
      if (fold) {
        e.preventDefault();
        c.expandFold(+fold.dataset.group!);
      }
    };
    const onContext = (e: MouseEvent) => {
      const host = (e.target as Element).closest('[data-pane]') as HTMLElement | null;
      if (!host) return;
      e.preventDefault();
      const pane = host.dataset.pane as Pane;
      const v = c.views[pane];
      // Like IntelliJ, a right click outside the selection moves the caret first.
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null && !v.state.selection.ranges.some(r => pos >= r.from && pos <= r.to)) v.dispatch({ selection: { anchor: pos } });
      showMenu(
        c.contextMenu(pane, {
          compareClipboard: () => send('compareClipboard', { text: c.selectionText(pane), fileName: init.fileName }),
          toggleCollapse,
          toggleSync,
        }),
        anchorAt(e),
      );
    };
    const root = document.querySelector('.mg-panes')!;
    root.addEventListener('mousedown', onDown as EventListener, true);
    root.addEventListener('contextmenu', onContext as EventListener);
    return () => {
      root.removeEventListener('mousedown', onDown as EventListener, true);
      root.removeEventListener('contextmenu', onContext as EventListener);
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.popup')) return;
      if (e.key === 'F7') {
        e.preventDefault();
        c.navigate(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void finish('RESOLVED');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void finish('CANCEL');
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
        <Separator />
        <button ref={compareRef} class="action-button" data-tip="Compare Contents" onClick={() => showMenu(compareMenu(), anchorBelow(compareRef.current!))}>
          <Icon name="vcs/diff" />
          <span class="dropdown-mark" />
        </button>
        {init.contextLines !== -1 && <ActionButton icon="general/collapseAll" tip="Collapse Unchanged Fragments" toggled={settings.collapseUnchanged} onClick={toggleCollapse} />}
        <Separator />
        <span class="mg-toolbar-label">Apply non-conflicting changes:</span>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('left')} data-tip="Apply Non-Conflicting Changes from the Left Side" onClick={() => c.applyNonConflicting('left')}>
          <Icon name="diff/applyNotConflictsLeft" />
          Left
        </button>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('base')} data-tip="Apply All Non-Conflicting Changes" onClick={() => c.applyNonConflicting('base')}>
          <Icon name="diff/applyNotConflicts" />
          All
        </button>
        <button class="mg-text-action" disabled={!ready || !c.hasNonConflicting('right')} data-tip="Apply Non-Conflicting Changes from the Right Side" onClick={() => c.applyNonConflicting('right')}>
          <Icon name="diff/applyNotConflictsRight" />
          Right
        </button>
        <Separator />
        <ActionButton icon="diff/magicResolveToolbar" tip="Resolve Simple Conflicts" disabled={!ready || !c.hasResolvable()} onClick={() => c.resolveSimpleConflicts()} />
        <ActionButton icon="diff/revert@14x14" tip="Revert Conflict Resolution" disabled={!ready || !c.contentModified} onClick={() => void revert()} />
        <span class="spacer" />
        <span class={`mg-status ${done ? 'done' : ''}`}>
          {done && <Icon name="general/greenCheckmark" />}
          {statusText(s)}
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
      <div class="mg-panes">
        {balloon && (
          <div class="mg-balloon" role="status">
            <Icon name="general/greenCheckmark" />
            <div>
              <div class="mg-balloon-title">All changes have been processed</div>
              <a class="link" onClick={() => void finish('RESOLVED')}>
                Apply Changes
              </a>
            </div>
            <button class="action-button" data-tip="Close" onClick={() => setBalloon(false)}>
              <Icon name="general/closeSmall" />
            </button>
          </div>
        )}
        <div class="mg-pane mg-left" data-pane="left">
          <div class="mg-host" ref={hosts.left} />
        </div>
        <svg class="mg-divider" ref={d1} />
        <div class="mg-pane mg-result" data-pane="result">
          <div class="mg-host" ref={hosts.result} />
        </div>
        <svg class="mg-divider" ref={d2} />
        <div class="mg-pane mg-right" data-pane="right">
          <div class="mg-host" ref={hosts.right} />
        </div>
      </div>
      <div class="mg-south">
        <Button onClick={() => void finish('LEFT')}>Accept Left</Button>
        <Button onClick={() => void finish('RIGHT')}>Accept Right</Button>
        <span class="spacer" />
        <Button onClick={() => void finish('CANCEL')}>{init.iterative ? 'Save and Close' : 'Cancel'}</Button>
        <Button primary onClick={() => void finish('RESOLVED')}>
          Apply Changes
        </Button>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
