import * as vscode from 'vscode';
import { showDialog } from './dialog';
import { CancelledError, showError } from './webviewHost';

/**
 * Runs a background task with progress, like IntelliJ's Task.Backgroundable: the title is shown in the
 * status bar progress, cancellable tasks show a notification with a Cancel button.
 */
export function withProgress<T>(
  title: string,
  fn: (progress: (text: string) => void, token: vscode.CancellationToken) => Promise<T>,
  opts: { cancellable?: boolean; location?: 'notification' | 'window' } = {},
): Promise<T> {
  const location = opts.location === 'window' ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
  return Promise.resolve(
    vscode.window.withProgress({ location, title, cancellable: opts.cancellable ?? location === vscode.ProgressLocation.Notification }, (p, token) =>
      fn(text => p.report({ message: text }), token),
    ),
  );
}

/** Success balloon (IntelliJ "VCS Notifications" success group). */
export async function notifySuccess(title: string, content?: string, ...actions: { label: string; run: () => unknown }[]) {
  const text = content ? vscode.l10n.t('{0}: {1}', title, content) : title;
  const picked = await vscode.window.showInformationMessage(text, ...actions.map(a => a.label));
  actions.find(a => a.label === picked)?.run();
}

export async function notifyWarning(title: string, content?: string, ...actions: { label: string; run: () => unknown }[]) {
  const text = content ? vscode.l10n.t('{0}: {1}', title, content) : title;
  const picked = await vscode.window.showWarningMessage(text, ...actions.map(a => a.label));
  actions.find(a => a.label === picked)?.run();
}

export function notifyError(e: unknown, title?: string) {
  showError(e, title);
}

/**
 * Modal yes/no question using VS Code's native modal message box (fast, keyboard friendly).
 * Returns the label of the chosen button, or undefined when cancelled.
 */
export async function ask(message: string, detail: string | undefined, ...buttons: string[]): Promise<string | undefined> {
  return vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);
}

/** IntelliJ-style message dialog with a checkbox, rendered in a webview dialog. */
export async function confirmDialog(opts: {
  title: string;
  message: string;
  icon?: 'question' | 'warning' | 'error' | 'information';
  buttons: { id: string; label: string; primary?: boolean }[];
  checkbox?: string;
  details?: string;
}): Promise<{ button: string; checked: boolean } | undefined> {
  return showDialog('confirm', opts, { title: opts.title });
}

/** Input box with validation. Throws CancelledError when cancelled. */
export async function input(opts: vscode.InputBoxOptions): Promise<string> {
  const v = await vscode.window.showInputBox({ ignoreFocusOut: true, ...opts });
  if (v === undefined) throw new CancelledError();
  return v;
}

export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return vscode.l10n.t('moments ago');
  if (diff < 3600) return vscode.l10n.t('{0} minutes ago', Math.floor(diff / 60));
  if (diff < 86400) return vscode.l10n.t('{0} hours ago', Math.floor(diff / 3600));
  if (diff < 86400 * 2) return vscode.l10n.t('yesterday');
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
