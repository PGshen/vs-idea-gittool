import { useState } from 'preact/hooks';
import { Button } from '../../../lib/components';
import { t } from '../../../lib/l10n';
import { DialogFrame } from '../../frame';
import { registerDialog } from '../../registry';

export interface NewCommitMessageProps {
  /** Text above the editor, e.g. "Changes extracted from commit abc12345 by author". */
  label: string;
  message: string;
  okText?: string;
}

/** GitNewCommitMessageActionDialog: commit message editor used by "Extract Selected Changes to Separate Commit…". */
registerDialog<NewCommitMessageProps>('log.newCommitMessage', ({ props, submit, cancel }) => {
  const [message, setMessage] = useState(props.message);
  const [error, setError] = useState<string>();
  const ok = async () => {
    const e = await submit({ message });
    if (e !== undefined) setError(e || undefined);
  };
  return (
    <DialogFrame
      title={t('New Commit Message')}
      width={600}
      onCancel={cancel}
      onOk={ok}
      error={error}
      buttons={
        <>
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button primary onClick={ok} disabled={!message.trim()}>
            {props.okText ?? t('OK')}
          </Button>
        </>
      }
    >
      <div style={{ padding: '2px 0 4px' }}>{props.label}</div>
      <textarea
        class="text-area mono"
        rows={12}
        autofocus
        spellcheck={false}
        value={message}
        onInput={e => {
          setMessage((e.currentTarget as HTMLTextAreaElement).value);
          setError(undefined);
        }}
        style={{ width: '100%', minHeight: '220px', fontFamily: "'JetBrains Mono', var(--vscode-editor-font-family), Menlo, Consolas, monospace" }}
      />
    </DialogFrame>
  );
});
