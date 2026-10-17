import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';

/**
 * Status bar widgets mirroring Rebased's main toolbar (MainToolbarVCSGroup):
 * [Project] [Update Project ↙] [Push… ↗] [Branch widget] [Merge/Rebase widget].
 */
export class StatusBarWidgets implements vscode.Disposable {
  private readonly project: vscode.StatusBarItem;
  private readonly update: vscode.StatusBarItem;
  private readonly push: vscode.StatusBarItem;
  private readonly branch: vscode.StatusBarItem;
  private readonly opItems: vscode.StatusBarItem[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  /** Repository chosen with the project widget; otherwise the one of the active editor. */
  private pinned: string | undefined;

  constructor(private readonly ctx: Ctx) {
    const left = vscode.StatusBarAlignment.Left;
    // High priorities keep the widgets at the start of the status bar, in toolbar order.
    this.project = vscode.window.createStatusBarItem('rebased.project', left, 1000);
    this.project.name = 'Rebased: Project';
    this.update = vscode.window.createStatusBarItem('rebased.update', left, 999);
    this.update.name = 'Rebased: Update Project';
    this.update.text = '↙';
    this.update.tooltip = 'Update Project (Ctrl+T)';
    this.update.command = { command: 'rebased.updateProject', title: 'Update Project', arguments: [] };
    this.push = vscode.window.createStatusBarItem('rebased.push', left, 998);
    this.push.name = 'Rebased: Push';
    this.push.text = '↗';
    this.push.tooltip = 'Push… (Ctrl+Shift+K)';
    this.push.command = { command: 'rebased.push', title: 'Push…', arguments: [] };
    this.branch = vscode.window.createStatusBarItem('rebased.branch', left, 997);
    this.branch.name = 'Rebased: Git Branch';
    for (let i = 0; i < 3; i++) {
      const it = vscode.window.createStatusBarItem(`rebased.operation.${i}`, left, 996 - i);
      it.name = 'Rebased: Merge/Rebase Actions';
      this.opItems.push(it);
    }
    ctx.repos.onDidChangeRepository(() => this.render(), null, this.disposables);
    ctx.repos.onDidChangeRepositories(() => this.render(), null, this.disposables);
    vscode.window.onDidChangeActiveTextEditor(() => this.render(), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('rebased.statusBar') && this.render(), null, this.disposables);
    this.render();
  }

  /** The repository the widgets show. */
  activeRepo(): Repository | undefined {
    const repos = this.ctx.repos.repositories;
    if (this.pinned) {
      const p = this.ctx.repos.get(this.pinned);
      if (p) return p;
    }
    const doc = vscode.window.activeTextEditor?.document.uri;
    if (doc?.scheme === 'file') {
      const r = this.ctx.repos.getForFile(doc.fsPath);
      if (r) return r;
    }
    return repos[0];
  }

  async pickProjectRepo() {
    const repos = this.ctx.repos.repositories;
    const picked = await vscode.window.showQuickPick(
      repos.map(r => ({ label: r.name, description: r.info.branch ?? r.info.headHash?.slice(0, 8), detail: r.root, root: r.root })),
      { placeHolder: 'Select the repository shown in the toolbar' },
    );
    if (picked) {
      this.pinned = picked.root;
      this.render();
    }
  }

  render() {
    const repo = this.activeRepo();
    const show = vscode.workspace.getConfiguration('rebased').get<boolean>('statusBar.enabled', true);
    if (!repo || !show) {
      [this.project, this.update, this.push, this.branch, ...this.opItems].forEach(i => i.hide());
      if (show && this.ctx.repos.repositories.length === 0) {
        // "Version Control" widget when there is no repository.
        this.branch.text = '$(source-control) Version Control';
        this.branch.tooltip = 'Configure a version control for the project';
        this.branch.command = { command: 'rebased.init', title: 'Create Git Repository…' };
        this.branch.show();
      }
      return;
    }
    const multi = this.ctx.repos.repositories.length > 1;
    this.project.text = `$(repo) ${repo.name}`;
    this.project.tooltip = multi ? `${repo.root}\nClick to choose the repository` : repo.root;
    this.project.command = multi ? { command: 'rebased.ops.pickToolbarRepository', title: 'Select Repository' } : undefined;
    if (multi) this.project.show();
    else this.project.hide();
    this.update.command = { command: 'rebased.updateProject', title: 'Update Project', arguments: [] };
    this.push.command = { command: 'rebased.push', title: 'Push…', arguments: [] };
    this.update.show();
    this.push.show();

    const info = repo.info;
    const op = repo.detectOperation();
    const name = info.branch ?? (info.headHash ? info.headHash.slice(0, 8) : 'HEAD');
    let text: string;
    if (op === 'rebase') text = `$(warning) Rebasing ${info.rebaseHeadName ?? name}`;
    else if (op === 'merge') text = `$(warning) Merging ${name}`;
    else if (op === 'cherry-pick') text = `$(warning) Cherry-picking in ${name}`;
    else if (op === 'revert') text = `$(warning) Reverting in ${name}`;
    else if (info.detached) text = `$(warning) ${name}`;
    else text = `$(git-branch) ${name}`;
    const counts: string[] = [];
    if (info.behind) counts.push(`↓${info.behind}`);
    if (info.ahead) counts.push(`↑${info.ahead}`);
    this.branch.text = counts.length ? `${text} ${counts.join(' ')}` : text;
    const tip: string[] = [info.detached ? "Git: Detached HEAD doesn't point to any branch" : `Git Branch: ${name}`];
    const sync = multi && vscode.workspace.getConfiguration('rebased').get<boolean>('branches.syncControl', true);
    if (sync) {
      // Synchronous branch control: the widget stands for all repositories.
      const repos = this.ctx.repos.repositories;
      const names = new Set(repos.map(r => r.info.branch ?? r.info.headHash?.slice(0, 8) ?? 'HEAD'));
      if (names.size === 1 && op === 'none') {
        const behind = repos.reduce((s, r) => s + r.info.behind, 0);
        const ahead = repos.reduce((s, r) => s + r.info.ahead, 0);
        const c = [behind ? `↓${behind}` : '', ahead ? `↑${ahead}` : ''].filter(Boolean).join(' ');
        this.branch.text = `$(git-branch) ${name}${c ? ' ' + c : ''}`;
      }
      tip.length = 0;
      tip.push(names.size === 1 ? `Git Branch: ${name} (in all ${repos.length} repositories)` : 'Git Branches:');
      for (const r of repos) tip.push(`${r.name}: ${r.info.branch ?? r.info.headHash?.slice(0, 8) ?? 'HEAD'}${r.info.behind ? ` ↓${r.info.behind}` : ''}${r.info.ahead ? ` ↑${r.info.ahead}` : ''}`);
    } else if (multi) tip.push(`Root: ${repo.name}`);
    if (info.behind) tip.push(`${info.behind} incoming ${info.behind === 1 ? 'commit' : 'commits'}`);
    if (info.ahead) tip.push(`${info.ahead} outgoing ${info.ahead === 1 ? 'commit' : 'commits'}`);
    if (op === 'rebase') tip.push('Git: Rebase in progress');
    this.branch.tooltip = tip.join('\n');
    this.branch.command = { command: 'rebased.branches', title: 'Branches…', arguments: [{ root: repo.root }] };
    this.branch.backgroundColor = op !== 'none' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.branch.show();

    // Merge/Rebase widget (GitMergeRebaseWidgetGroup).
    const arg = [{ root: repo.root }];
    const actions: { text: string; tooltip: string; command: string; error?: boolean }[] = [];
    const conflicts = repo.status.conflicts.length > 0;
    if (conflicts) actions.push({ text: '$(git-merge) Resolve Conflicts…', tooltip: 'Resolve Conflicts…', command: 'rebased.resolveConflicts' });
    if (op === 'rebase') {
      if (!conflicts) actions.push({ text: '$(debug-continue) Continue Rebase', tooltip: 'Continue Rebase', command: 'rebased.continueOperation' });
      actions.push({ text: '$(debug-stop) Abort Rebase', tooltip: 'Abort Rebase', command: 'rebased.abortOperation', error: true });
    } else if (op === 'merge') {
      if (!conflicts) actions.push({ text: '$(check) Commit merge', tooltip: 'Commit merge', command: 'rebased.continueOperation' });
      actions.push({ text: '$(debug-stop) Abort Merge', tooltip: 'Abort Merge', command: 'rebased.abortOperation', error: true });
    } else if (op === 'cherry-pick') {
      if (!conflicts) actions.push({ text: '$(debug-continue) Continue Cherry-Pick', tooltip: 'Continue Cherry-Pick', command: 'rebased.continueOperation' });
      actions.push({ text: '$(debug-stop) Abort Cherry-Pick', tooltip: 'Abort Cherry-Pick', command: 'rebased.abortOperation', error: true });
    } else if (op === 'revert') {
      actions.push({ text: '$(debug-stop) Abort Revert', tooltip: 'Abort Revert', command: 'rebased.abortOperation', error: true });
    }
    this.opItems.forEach((it, i) => {
      const a = actions[i];
      if (!a) return it.hide();
      it.text = a.text;
      it.tooltip = a.tooltip;
      it.command = { command: a.command, title: a.tooltip, arguments: arg };
      it.backgroundColor = a.error ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      it.color = a.error ? undefined : new vscode.ThemeColor('testing.iconPassed');
      it.show();
    });
    void vscode.commands.executeCommand('setContext', 'rebased.operation', op);
    void vscode.commands.executeCommand('setContext', 'rebased.hasConflicts', conflicts);
  }

  dispose() {
    [this.project, this.update, this.push, this.branch, ...this.opItems].forEach(i => i.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}
