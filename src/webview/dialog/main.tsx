import { render } from 'preact';
import { useState } from 'preact/hooks';
import '../lib/base.css';
import './dialog.css';
import { t } from '../lib/l10n';
import { boot, call } from '../lib/rpc';
import { getDialog } from './registry';
import './dialogs';

function App() {
  const { kind, props } = boot.initial as { kind: string; props: unknown };
  const Component = getDialog(kind);
  const [, setBusy] = useState(false);
  if (!Component) return <div class="empty-text">{t('Unknown dialog: {0}', kind)}</div>;
  const submit = async (value: unknown) => {
    setBusy(true);
    try {
      const r = await call<{ ok: boolean; error?: string }>('submit', value);
      return r.ok ? undefined : (r.error ?? '');
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      setBusy(false);
    }
  };
  return <Component props={props} submit={submit} cancel={() => call('cancel')} />;
}

render(<App />, document.getElementById('root')!);
