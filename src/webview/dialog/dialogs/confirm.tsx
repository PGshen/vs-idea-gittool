import { useState } from 'preact/hooks';
import { Button, Checkbox } from '../../lib/components';
import { Icon } from '../../lib/icons';
import { DialogFrame } from '../frame';
import { registerDialog } from '../registry';

export interface ConfirmProps {
  title: string;
  message: string;
  /** Icon: 'question' | 'warning' | 'error' | 'information' */
  icon?: string;
  buttons: { id: string; label: string; primary?: boolean }[];
  /** Optional "Do not ask again" style checkbox. */
  checkbox?: string;
  details?: string;
}

/** Generic message dialog (Messages.showYesNoDialog and friends). Submits { button, checked }. */
registerDialog<ConfirmProps>('confirm', ({ props, submit, cancel }) => {
  const [checked, setChecked] = useState(false);
  const primary = props.buttons.find(b => b.primary) ?? props.buttons[0];
  return (
    <DialogFrame
      title={props.title}
      width={480}
      onCancel={cancel}
      onOk={() => submit({ button: primary.id, checked })}
      buttons={props.buttons.map(b => (
        <Button key={b.id} primary={b.primary} onClick={() => submit({ button: b.id, checked })}>
          {b.label}
        </Button>
      ))}
      left={props.checkbox ? <Checkbox checked={checked} onChange={setChecked} label={props.checkbox} /> : undefined}
    >
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '4px 0 8px' }}>
        <Icon name={`general/${props.icon ?? 'question'}Dialog`} size={20} />
        <div style={{ whiteSpace: 'pre-wrap', userSelect: 'text', lineHeight: '20px' }}>{props.message}</div>
      </div>
      {props.details && <pre class="mono secondary" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: '240px', overflow: 'auto', userSelect: 'text' }}>{props.details}</pre>}
    </DialogFrame>
  );
});
