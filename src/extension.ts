import * as vscode from 'vscode';
import { Ctx } from './context';
import { openDiffSource } from './host/diffSource';
import { setGitPath } from './git/exec';
import { RepositoryManager } from './git/manager';
import { GIT_SCHEME, GitContentProvider } from './host/gitContent';
import { getOutputChannel } from './host/output';
import { initWebviewHost, showError } from './host/webviewHost';
import { FEATURES } from './features';
import { translate } from './shared/l10n';
import { initLanguage } from './host/l10n';

export async function activate(extension: vscode.ExtensionContext) {
  initWebviewHost(extension);
  const cfg = () => vscode.workspace.getConfiguration('ideagittool');
  initLanguage(extension);
  setGitPath(cfg().get<string>('gitPath'));
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('ideagittool.gitPath')) setGitPath(cfg().get<string>('gitPath'));
    if (e.affectsConfiguration('ideagittool.language')) {
      const reload = translate('Reload Window');
      void vscode.window.showInformationMessage(translate('Reload the window to apply the IdeaGitTool language change.'), reload).then(action => {
        if (action === reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }
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

  ctx.command('ideagittool.showConsole', () => getOutputChannel().show());
  ctx.command('ideagittool.diff.openSource', resource => openDiffSource(resource));

  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', 'ideagittool.hasRepository', repos.repositories.length > 0);
    void vscode.commands.executeCommand('setContext', 'ideagittool.multipleRepositories', repos.repositories.length > 1);
  };
  repos.onDidChangeRepositories(updateContext);

  for (const feature of FEATURES) feature(ctx);

  await repos.scan();
  updateContext();
}

export function deactivate() {}
