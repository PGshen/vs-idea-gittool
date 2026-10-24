import { useState } from 'preact/hooks';
import { Button, Checkbox } from '../../../lib/components';
import { t } from '../../../lib/l10n';
import { changeKey, ShelfInfo } from '../../../../shared/commitProtocol';
import { Change } from '../../../../shared/types';
import { DialogFrame, Row } from '../../frame';
import { registerDialog } from '../../registry';
import { ChangesSelector } from './changesSelector';

/** Rollback Changes: changes with "Include in Rollback" checkboxes and "Delete local copies of added files". */
registerDialog<{ files: Change[]; selected: string[]; groupByDirectory: boolean }>('commit.rollback', ({ props, submit, cancel }) => {
  const [included, setIncluded] = useState(new Set(props.selected));
  const [deleteAdded, setDeleteAdded] = useState(false);
  const [error, setError] = useState<string>();
  const hasAdded = props.files.some(f => included.has(changeKey(f)) && (f.status === 'A' || f.status === 'C'));
  const ok = async () => setError(await submit({ keys: [...included], deleteAdded }));
  return (
    <DialogFrame
      title={t('Rollback Changes')}
      width={620}
      height={520}
      resizable
      onCancel={cancel}
      onOk={ok}
      okDisabled={!included.size}
      error={error}
      left={<Checkbox checked={deleteAdded} disabled={!hasAdded} onChange={setDeleteAdded} label={t('Delete local copies of added files')} />}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary disabled={!included.size} onClick={ok}>
            {t('Rollback')}
          </Button>
        </>
      }
    >
      <ChangesSelector files={props.files} included={included} onIncludedChange={setIncluded} groupByDirectory={props.groupByDirectory} />
    </DialogFrame>
  );
});

/** Shelve Changes: commit-like dialog with the changes and the shelf name as the "commit message". */
registerDialog<{ files: Change[]; selected: string[]; name: string; groupByDirectory: boolean }>('commit.shelve', ({ props, submit, cancel }) => {
  const [included, setIncluded] = useState(new Set(props.selected));
  const [name, setName] = useState(props.name);
  const [error, setError] = useState<string>();
  const ok = async () => setError(await submit({ keys: [...included], name }));
  return (
    <DialogFrame
      title={t('Shelve Changes')}
      width={640}
      height={600}
      resizable
      onCancel={cancel}
      onOk={ok}
      okDisabled={!included.size}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary disabled={!included.size} onClick={ok}>
            {t('Shelve Changes')}
          </Button>
        </>
      }
    >
      <ChangesSelector files={props.files} included={included} onIncludedChange={setIncluded} groupByDirectory={props.groupByDirectory} />
      <label class="secondary" style={{ marginTop: '6px' }}>
        {t('Commit Message')}
      </label>
      <textarea
        class="text-area mono"
        style={{ height: '110px', flex: 'none', userSelect: 'text' }}
        placeholder={t('Commit Message')}
        value={name}
        onInput={e => setName((e.currentTarget as HTMLTextAreaElement).value)}
      />
    </DialogFrame>
  );
});

/** Unshelve Changes: target changelist, "Remove successfully applied files from the shelf", file selection. */
registerDialog<{ shelf: ShelfInfo; selected: string[]; changelists: string[]; changelist: string }>('commit.unshelve', ({ props, submit, cancel }) => {
  const keyOf = (c: Change) => c.path;
  const [included, setIncluded] = useState(new Set(props.selected));
  const [changelist, setChangelist] = useState(props.changelist);
  const [removeApplied, setRemoveApplied] = useState(true);
  const [error, setError] = useState<string>();
  const ok = async () => setError(await submit({ paths: [...included], changelist: changelist.trim(), removeApplied }));
  return (
    <DialogFrame
      title={t('Unshelve Changes')}
      width={620}
      height={540}
      resizable
      onCancel={cancel}
      onOk={ok}
      okDisabled={!included.size}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary disabled={!included.size} onClick={ok}>
            {t('OK')}
          </Button>
        </>
      }
    >
      <Row label={t('Name:')}>
        <input class="text-field" list="changelist-names" value={changelist} onInput={e => setChangelist((e.currentTarget as HTMLInputElement).value)} />
        <datalist id="changelist-names">
          {props.changelists.map(n => (
            <option value={n} key={n} />
          ))}
        </datalist>
      </Row>
      <Checkbox checked={removeApplied} onChange={setRemoveApplied} label={t('Remove successfully applied files from the shelf')} />
      <ChangesSelector files={props.shelf.files} included={included} onIncludedChange={setIncluded} keyOf={keyOf} rootLabel={props.shelf.name} />
    </DialogFrame>
  );
});

/** New Changelist / Edit Changelist. */
registerDialog<{ mode: 'new' | 'edit'; name: string; comment: string; makeActive: boolean; existing: string[] }>('commit.changelist', ({ props, submit, cancel }) => {
  const [name, setName] = useState(props.name);
  const [comment, setComment] = useState(props.comment);
  const [makeActive, setMakeActive] = useState(props.makeActive);
  const [error, setError] = useState<string>();
  const validation = !name.trim() ? t('Changelist name cannot be empty') : props.existing.includes(name.trim()) ? t('Changelist "{0}" already exists', name.trim()) : undefined;
  const ok = async () => {
    if (validation) return setError(validation);
    setError(await submit({ name: name.trim(), comment, makeActive }));
  };
  return (
    <DialogFrame
      title={props.mode === 'new' ? t('New Changelist') : t('Edit Changelist')}
      width={460}
      onCancel={cancel}
      onOk={ok}
      error={error}
      left={<Checkbox checked={makeActive} onChange={setMakeActive} label={t('Set active')} disabled={props.mode === 'edit' && props.makeActive} />}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok} disabled={!!validation}>
            {t('OK')}
          </Button>
        </>
      }
    >
      <Row label={t('Name:')}>
        <input class={`text-field ${error && validation ? 'error' : ''}`} autofocus value={name} onInput={e => (setName((e.currentTarget as HTMLInputElement).value), setError(undefined))} />
      </Row>
      <Row label={t('Comment:')} top>
        <textarea class="text-area" style={{ height: '90px', userSelect: 'text' }} value={comment} onInput={e => setComment((e.currentTarget as HTMLTextAreaElement).value)} />
      </Row>
    </DialogFrame>
  );
});
