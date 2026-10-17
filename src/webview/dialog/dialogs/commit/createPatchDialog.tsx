import { useState } from 'preact/hooks';
import { Button, Checkbox, Radio } from '../../../lib/components';
import { Icon } from '../../../lib/icons';
import { call } from '../../../lib/rpc';
import { Change } from '../../../../shared/types';
import { DialogFrame, Group, Row } from '../../frame';
import { registerDialog } from '../../registry';
import { ChangesSelector } from './changesSelector';

export interface CreatePatchProps {
  files: (Change & { key: string })[];
  selected: string[];
  path: string;
  basePath: string;
  toClipboard: boolean;
  reverse: boolean;
  encoding: string;
  groupByDirectory: boolean;
  /** Title of the file tree root ("Changes", the shelf or commit name). */
  rootLabel?: string;
}

const ENCODINGS = [
  ['utf8', 'UTF-8'],
  ['utf16le', 'UTF-16LE'],
  ['latin1', 'ISO-8859-1'],
  ['ascii', 'US-ASCII'],
];

/**
 * Create Patch (IntelliJ CreatePatchCommitExecutor): the changes to include, then "Patch File Settings":
 * To file / To clipboard, Base path, Reverse patch, Encoding.
 */
registerDialog<CreatePatchProps>('commit.createPatch', ({ props, submit, cancel }) => {
  const [included, setIncluded] = useState(new Set(props.selected));
  const [toClipboard, setToClipboard] = useState(props.toClipboard);
  const [file, setFile] = useState(props.path);
  const [basePath, setBasePath] = useState(props.basePath);
  const [reverse, setReverse] = useState(props.reverse);
  const [encoding, setEncoding] = useState(props.encoding);
  const [error, setError] = useState<string>();
  const canOk = included.size > 0 && (toClipboard || !!file.trim());
  const ok = async () => {
    if (!canOk) return;
    setError(await submit({ keys: [...included], toClipboard, path: file.trim(), basePath: basePath.trim(), reverse, encoding }));
  };
  const keyOf = (c: Change) => (c as Change & { key: string }).key;
  return (
    <DialogFrame
      title="Create Patch"
      width={680}
      height={640}
      resizable
      onCancel={cancel}
      onOk={ok}
      okDisabled={!canOk}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary disabled={!canOk} onClick={ok}>
            Create Patch
          </Button>
        </>
      }
    >
      <ChangesSelector files={props.files} included={included} onIncludedChange={setIncluded} groupByDirectory={props.groupByDirectory} keyOf={keyOf} rootLabel={props.rootLabel} />
      <Group title="Patch File Settings">
        <div class="wide-labels" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <Row label={<Radio name="target" checked={!toClipboard} onChange={() => setToClipboard(false)} label="To file:" />}>
            <input class="text-field" value={file} disabled={toClipboard} spellcheck={false} onInput={e => setFile((e.currentTarget as HTMLInputElement).value)} />
            <button
              class="action-button"
              data-tip="Save Patch to"
              disabled={toClipboard}
              onClick={async () => {
                const p = await call<string | null>('browseFile', file);
                if (p) setFile(p);
              }}
            >
              <Icon name="inline/browse" />
            </button>
          </Row>
          <Row label={<Radio name="target" checked={toClipboard} onChange={() => setToClipboard(true)} label="To clipboard" />}>
            <span />
          </Row>
          <Row label="Base path:">
            <input class="text-field" value={basePath} spellcheck={false} onInput={e => setBasePath((e.currentTarget as HTMLInputElement).value)} />
            <button
              class="action-button"
              data-tip="Select Base Directory for Patch"
              onClick={async () => {
                const p = await call<string | null>('browseDir', basePath);
                if (p) setBasePath(p);
              }}
            >
              <Icon name="inline/browse" />
            </button>
          </Row>
          <Row label="">
            <Checkbox checked={reverse} onChange={setReverse} label="Reverse patch" />
          </Row>
          <Row label="Encoding:">
            <select class="combo" style={{ flex: 'none', minWidth: '160px' }} value={encoding} onChange={e => setEncoding((e.currentTarget as HTMLSelectElement).value)}>
              {ENCODINGS.map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </Group>
    </DialogFrame>
  );
});
