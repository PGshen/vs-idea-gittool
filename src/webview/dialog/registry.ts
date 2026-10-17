import { FunctionComponent } from 'preact';

export interface DialogProps<P = any> {
  props: P;
  /** Validates on the host and closes the dialog; resolves with an error message when the host refused. */
  submit: (value: unknown) => Promise<string | undefined>;
  cancel: () => void;
}

const registry = new Map<string, FunctionComponent<DialogProps>>();

export function registerDialog<P>(kind: string, component: FunctionComponent<DialogProps<P>>) {
  registry.set(kind, component as FunctionComponent<DialogProps>);
}

export function getDialog(kind: string) {
  return registry.get(kind);
}
