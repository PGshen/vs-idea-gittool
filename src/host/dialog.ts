import * as vscode from 'vscode';
import { getExtensionUri, Handler, WebviewConnection } from './webviewHost';

export interface DialogOptions {
  /** Window title, e.g. "Push Commits to rebased". */
  title: string;
  /** Extra RPC handlers the dialog can call while open (e.g. to load commits). */
  handlers?: Record<string, Handler>;
  /** Called with the connection, to push events to the dialog. */
  onOpen?: (conn: WebviewConnection) => void;
  /**
   * Called on submit. Return false (or throw) to keep the dialog open, e.g. after a validation error.
   * Otherwise the dialog closes and `showDialog` resolves with the submitted value.
   */
  validate?: (value: any) => Promise<boolean | string | void> | boolean | string | void;
}

let openDialogs = 0;

/**
 * Shows an IntelliJ-style dialog. The dialog is rendered by the `dialog` webview bundle,
 * component `kind` (see src/webview/dialog/registry.ts). Resolves with the value passed to
 * `submit`, or undefined when cancelled / closed.
 */
export function showDialog<T = any>(kind: string, props: unknown, opts: DialogOptions): Promise<T | undefined> {
  return new Promise<T | undefined>(resolve => {
    const panel = vscode.window.createWebviewPanel(
      'rebased.dialog',
      opts.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { retainContextWhenHidden: true, enableFindWidget: false },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'commit.svg'),
      dark: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'commit_dark.svg'),
    };
    openDialogs++;
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
      panel.dispose();
    };
    const conn = new WebviewConnection(panel.webview, 'dialog', () => ({ kind, props, title: opts.title }), opts.title);
    conn.handleAll(opts.handlers ?? {});
    conn.handle('submit', async (value: T) => {
      if (opts.validate) {
        const r = await opts.validate(value);
        if (r === false) return { ok: false };
        if (typeof r === 'string') return { ok: false, error: r };
      }
      finish(value);
      return { ok: true };
    });
    conn.handle('cancel', () => finish(undefined));
    conn.handle('setTitle', (t: string) => {
      panel.title = t;
    });
    panel.onDidDispose(() => {
      openDialogs--;
      conn.dispose();
      if (!done) {
        done = true;
        resolve(undefined);
      }
    });
    opts.onOpen?.(conn);
  });
}

export function isDialogOpen() {
  return openDialogs > 0;
}
