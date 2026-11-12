// Diff preview of the Commit tool window (IntelliJ's "Show Diff Preview" in the Local Changes view): the diff editor
// follows the selected file, so a single click or arrow key shows its changes without a double click.
import { changeKey } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';

type SelectedNode = { data?: { kind: string; change?: Change } };

/** Key of the file the preview shows for a selection: exactly one selected file row that has a diff, else undefined. */
export function diffPreviewKey(selected: SelectedNode[]): string | undefined {
  if (selected.length !== 1) return undefined;
  const d = selected[0].data;
  if (d?.kind !== 'file' || !d.change || d.change.status === '!') return undefined;
  return changeKey(d.change);
}
