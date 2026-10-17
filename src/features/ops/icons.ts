import * as vscode from 'vscode';
import { getExtensionUri } from '../../host/webviewHost';

/** IntelliJ icon (media/icons/<name>.svg + _dark variant) for QuickPick items and buttons. */
export function ijIcon(name: string): { light: vscode.Uri; dark: vscode.Uri } {
  const base = getExtensionUri();
  return {
    light: vscode.Uri.joinPath(base, 'media', 'icons', `${name}.svg`),
    dark: vscode.Uri.joinPath(base, 'media', 'icons', `${name}_dark.svg`),
  };
}
