import * as path from 'node:path';
import * as vscode from 'vscode';
import { fromGitUri, GIT_SCHEME } from './gitContent';

/** Open the working file rather than the read-only revision displayed in a diff. */
export async function openDiffSource(resource?: unknown) {
  const editor = vscode.window.activeTextEditor;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  // Context menus pass the clicked resource. Embedded editors in a multi-diff
  // can lose activeTextEditor while the menu has focus.
  const clickedUri = resource instanceof vscode.Uri ? resource : undefined;
  // Use the new path even when the original side of a renamed file has focus.
  const uri = input instanceof vscode.TabInputTextDiff ? input.modified : clickedUri ?? editor?.document.uri;
  if (!uri) return;
  let source: vscode.Uri;
  if (uri.scheme === GIT_SCHEME) {
    const q = fromGitUri(uri);
    source = vscode.Uri.file(path.join(q.root, q.sourcePath ?? q.path));
  } else if (uri.scheme === 'file') {
    source = uri;
  } else {
    return;
  }

  try {
    await vscode.workspace.fs.stat(source);
  } catch {
    void vscode.window.showWarningMessage(`Source file is not available locally: ${source.fsPath}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(source);
  // A context menu may target a different embedded file from the last editor.
  const position = editor && (!clickedUri || clickedUri.toString() === editor.document.uri.toString())
    ? document.validatePosition(editor.selection.active)
    : undefined;
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.window.tabGroups.activeTabGroup.viewColumn,
    selection: position ? new vscode.Range(position, position) : undefined,
  });
}
