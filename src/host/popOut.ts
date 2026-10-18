import * as vscode from 'vscode';

/**
 * Moves a just-created webview panel into its own window (VS Code "auxiliary window", 1.85+) when
 * `ideagittool.dialogs.openInNewWindow` is on, so dialogs and the merge window float like in IntelliJ.
 * The window closes by itself when the panel is disposed.
 */
export async function popOutIfConfigured(panel: vscode.WebviewPanel): Promise<void> {
  if (!vscode.workspace.getConfiguration('ideagittool').get<boolean>('dialogs.openInNewWindow', false)) return;
  // The command acts on the active editor, so make sure the panel is the active one.
  panel.reveal(undefined, false);
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch {
    // Older VS Code without auxiliary windows: keep the panel as an editor tab.
  }
}
