import * as vscode from 'vscode';
import { Ctx } from './context';
import { setGitPath } from './git/exec';
import { RepositoryManager } from './git/manager';
import { GIT_SCHEME, GitContentProvider } from './host/gitContent';
import { getOutputChannel } from './host/output';
import { initWebviewHost, showError } from './host/webviewHost';
import { FEATURES } from './features';

export async function activate(extension: vscode.ExtensionContext) {
  initWebviewHost(extension);
  const cfg = () => vscode.workspace.getConfiguration('rebased');
  setGitPath(cfg().get<string>('gitPath'));
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('rebased.gitPath')) setGitPath(cfg().get<string>('gitPath'));
  }, null, extension.subscriptions);

  const repos = new RepositoryManager(extension);
  extension.subscriptions.push(repos);

  const content = new GitContentProvider(repos);
  extension.subscriptions.push(vscode.workspace.registerFileSystemProvider(GIT_SCHEME, content, { isReadonly: true, isCaseSensitive: true }));

  const ctx: Ctx = {
    extension,
    repos,
    command(id, fn) {
      extension.subscriptions.push(
        vscode.commands.registerCommand(id, async (...args: unknown[]) => {
          try {
            return await fn(...args);
          } catch (e) {
            showError(e);
          }
        }),
      );
    },
  };

  ctx.command('rebased.showConsole', () => getOutputChannel().show());

  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', 'rebased.hasRepository', repos.repositories.length > 0);
    void vscode.commands.executeCommand('setContext', 'rebased.multipleRepositories', repos.repositories.length > 1);
  };
  repos.onDidChangeRepositories(updateContext);

  for (const feature of FEATURES) feature(ctx);

  await repos.scan();
  updateContext();
}

export function deactivate() {}
