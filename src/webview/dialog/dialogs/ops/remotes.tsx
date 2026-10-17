import { useState } from 'preact/hooks';
import { Button, Checkbox } from '../../../lib/components';
import { Icon } from '../../../lib/icons';
import { call } from '../../../lib/rpc';
import { DialogFrame, Row } from '../../frame';
import { registerDialog } from '../../registry';

interface RemoteRow {
  root: string;
  repo: string;
  name: string;
  url: string;
}

// ------------------------------------------------------------------ Git Remotes (GitConfigureRemotesDialog)

registerDialog<{ remotes: RemoteRow[]; repos: { root: string; name: string }[] }>('ops.remotes', ({ props, submit, cancel }) => {
  const [rows, setRows] = useState<RemoteRow[]>(props.remotes);
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<{ mode: 'add' | 'edit'; root: string; oldName?: string; name: string; url: string; error?: string } | null>(null);
  const [error, setError] = useState<string>();
  const multi = props.repos.length > 1;
  const current = rows[sel];

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    const url = editing.url.trim();
    if (!name) return setEditing({ ...editing, error: 'Remote name cannot be empty' });
    if (!url) return setEditing({ ...editing, error: 'Remote URL cannot be empty' });
    if (/[\s~^:?*[\\]/.test(name)) return setEditing({ ...editing, error: 'Remote name contains illegal characters' });
    if (rows.some(r => r.root === editing.root && r.name === name && r.name !== editing.oldName)) return setEditing({ ...editing, error: `Remote name '${name}' is already used` });
    try {
      const updated = await call<RemoteRow[]>(editing.mode === 'add' ? 'addRemote' : 'editRemote', { root: editing.root, oldName: editing.oldName, name, url });
      setRows(updated);
      setEditing(null);
      setError(undefined);
    } catch (e) {
      setEditing({ ...editing, error: (e as Error).message });
    }
  };

  const remove = async () => {
    if (!current) return;
    try {
      setRows(await call<RemoteRow[]>('removeRemote', { root: current.root, name: current.name }));
      setSel(Math.max(0, sel - 1));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (editing) {
    return (
      <DialogFrame
        title={editing.mode === 'add' ? 'Define Remote' : 'Edit Remote'}
        width={520}
        onCancel={() => setEditing(null)}
        onOk={save}
        error={editing.error}
        buttons={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button primary onClick={save}>
              OK
            </Button>
          </>
        }
      >
        {multi && editing.mode === 'add' && (
          <Row label="Repository:">
            <select class="combo" value={editing.root} onChange={e => setEditing({ ...editing, root: (e.currentTarget as HTMLSelectElement).value })}>
              {props.repos.map(r => (
                <option value={r.root}>{r.name}</option>
              ))}
            </select>
          </Row>
        )}
        <Row label="Name:">
          <input class="text-field" value={editing.name} autofocus spellcheck={false} onInput={e => setEditing({ ...editing, name: (e.currentTarget as HTMLInputElement).value, error: undefined })} />
        </Row>
        <Row label="URL:">
          <input class="text-field" value={editing.url} spellcheck={false} onInput={e => setEditing({ ...editing, url: (e.currentTarget as HTMLInputElement).value, error: undefined })} />
        </Row>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame
      title="Git Remotes"
      width={640}
      onCancel={cancel}
      onOk={() => submit({})}
      error={error}
      buttons={
        <>
          <Button primary onClick={() => submit({})}>
            OK
          </Button>
        </>
      }
    >
      <div class="panel-box" style={{ minHeight: '240px' }}>
        <div class="toolbar" style={{ minHeight: '30px', borderBottom: '1px solid var(--border-subtle)' }}>
          <button
            class="action-button"
            data-tip="Add"
            onClick={() => setEditing({ mode: 'add', root: current?.root ?? props.repos[0].root, name: rows.some(r => r.name === 'origin') ? '' : 'origin', url: '' })}
          >
            <Icon name="general/add" />
          </button>
          <button class="action-button" data-tip="Remove" disabled={!current} onClick={remove}>
            <Icon name="general/remove" />
          </button>
          <button class="action-button" data-tip="Edit" disabled={!current} onClick={() => current && setEditing({ mode: 'edit', root: current.root, oldName: current.name, name: current.name, url: current.url })}>
            <Icon name="general/edit" />
          </button>
        </div>
        <div class="remote-table">
          <table class="table">
            <thead>
              <tr>
                {multi && <th>Repository</th>}
                <th>Name</th>
                <th style={{ width: '100%' }}>URL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.root}:${r.name}`}
                  class={i === sel ? 'selected' : ''}
                  onMouseDown={() => setSel(i)}
                  onDblClick={() => setEditing({ mode: 'edit', root: r.root, oldName: r.name, name: r.name, url: r.url })}
                >
                  {multi && <td class="secondary">{r.repo}</td>}
                  <td>{r.name}</td>
                  <td class="mono-text" style={{ maxWidth: '380px' }}>
                    {r.url}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div class="empty-text">No remotes defined</div>}
        </div>
      </div>
    </DialogFrame>
  );
});

// ------------------------------------------------------------------ Clone (GitCloneDialogComponent)

registerDialog<{ parent: string }>('ops.clone', ({ props, submit, cancel }) => {
  const [url, setUrl] = useState('');
  const [dir, setDir] = useState(props.parent);
  const [dirTouched, setDirTouched] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [depth, setDepth] = useState(1);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const repoName = (u: string) =>
    u
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .split(/[/:\\]/)
      .pop() ?? '';
  const onUrl = (u: string) => {
    setUrl(u);
    if (!dirTouched) setDir(joinPath(props.parent, repoName(u)));
  };
  const ok = async () => {
    if (!url.trim() || !dir.trim()) return;
    setBusy(true);
    setError(await submit({ url: url.trim(), dir: dir.trim(), depth: shallow ? depth : undefined }));
    setBusy(false);
  };
  return (
    <DialogFrame
      title="Clone Repository"
      width={640}
      onCancel={cancel}
      onOk={ok}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} disabled={!url.trim() || !dir.trim() || busy}>
            {busy ? 'Cloning…' : 'Clone'}
          </Button>
        </>
      }
    >
      <Row label="URL:">
        <input class="text-field" value={url} autofocus spellcheck={false} placeholder="https://github.com/user/repo.git" onInput={e => onUrl((e.currentTarget as HTMLInputElement).value)} />
      </Row>
      <Row label="Directory:">
        <input
          class="text-field"
          value={dir}
          spellcheck={false}
          onInput={e => {
            setDir((e.currentTarget as HTMLInputElement).value);
            setDirTouched(true);
          }}
        />
        <button
          class="action-button"
          data-tip="Browse…"
          onClick={async () => {
            const p = await call<string | null>('browse', dir);
            if (p) {
              setDir(joinPath(p, repoName(url)));
              setDirTouched(true);
            }
          }}
        >
          <Icon name="inline/browse" />
        </button>
      </Row>
      <div style={{ marginLeft: '98px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Checkbox checked={shallow} onChange={setShallow} label="Shallow clone with a history truncated to" />
        <input class="text-field" type="number" min={1} style={{ width: '70px' }} disabled={!shallow} value={depth} onInput={e => setDepth(Math.max(1, +(e.currentTarget as HTMLInputElement).value || 1))} />
        <span>commits</span>
      </div>
    </DialogFrame>
  );
});

function joinPath(parent: string, name: string) {
  if (!name) return parent;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}
