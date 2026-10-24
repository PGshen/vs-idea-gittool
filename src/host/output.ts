import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** The "Git" console: mirrors every git command, like the Console tab of IntelliJ's Git tool window. */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel(vscode.l10n.t('IdeaGitTool: Git Console'));
  return channel;
}

export function log(line: string) {
  const time = new Date().toTimeString().slice(0, 8);
  getOutputChannel().appendLine(`${time}.${String(new Date().getMilliseconds()).padStart(3, '0')}: ${line}`);
}
