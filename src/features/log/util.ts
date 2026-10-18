import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';

/** Resolves a file argument: an Uri (explorer / editor title), {root, path}, or the active editor. */
export async function fileFromArg(ctx: Ctx, arg: any): Promise<{ repo: Repository; path: string } | undefined> {
  await ctx.repos.ready();
  if (arg?.root && arg?.path) {
    const repo = ctx.repos.get(arg.root);
    return repo ? { repo, path: arg.path } : undefined;
  }
  let uri: vscode.Uri | undefined = arg instanceof vscode.Uri ? arg : arg?.resourceUri instanceof vscode.Uri ? arg.resourceUri : vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === 'ideagittool-git') {
    const q = JSON.parse(uri.query);
    const repo = ctx.repos.get(q.root);
    return repo ? { repo, path: q.path } : undefined;
  }
  if (!uri || uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('Select a file under Git version control.');
    return undefined;
  }
  const repo = ctx.repos.getForFile(uri.fsPath);
  if (!repo) {
    void vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} is not under Git version control.`);
    return undefined;
  }
  return { repo, path: repo.relPath(uri.fsPath) };
}

