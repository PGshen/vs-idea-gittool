import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { withProgress } from '../../host/ui';
import { BranchesRepo, BranchesState, BranchRef, RefAddress } from '../../shared/branchesProtocol';
import { Ref } from '../../shared/types';
import { topActionModel } from './branchActions';
import { newBranchCommand, recentBranches, refActionsFor, runRefAction, syncControl } from './branches';
import { activeRepo, settings } from './common';
import { fetch } from './engine';

const MAC = process.platform === 'darwin';

function toBranchRef(r: Ref): BranchRef {
  return {
    name: r.name,
    fullName: r.fullName,
    type: r.type as BranchRef['type'],
    current: r.current,
    favorite: r.favorite,
    ahead: r.ahead,
    behind: r.behind,
    upstream: r.upstream,
    remote: r.remote,
  };
}

/**
 * The Branches tab of the Commit tool window: IntelliJ's Git branches popup (GitBranchesTreePopup) as a tab.
 * The webview side is src/webview/commit/branchesTab.tsx.
 */
export class BranchesTab implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private fetching = false;

  constructor(private readonly ctx: Ctx) {
    ctx.commitView?.addHandlers({
      'branches.ready': () => this.state(),
      'branches.refActions': (p: RefAddress) => this.refActions(p),
      'branches.runRef': (p: RefAddress & { action: string }) => this.runRef(p),
      'branches.runTop': (p: { action: string }) => this.runTop(p.action),
      'branches.toggleFavorite': (p: RefAddress) => this.toggleFavorite(p),
      'branches.fetch': () => this.fetchAll(),
      'branches.setSetting': (p: { key: string; value: boolean }) => this.setSetting(p.key, p.value),
    });
    ctx.repos.onDidChangeRepository(e => e.refs && this.schedulePush(), null, this.disposables);
    ctx.repos.onDidChangeRepositories(() => this.schedulePush(), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('ideagittool.branches') && this.schedulePush(), null, this.disposables);
    // `ideagittool.operation` enables Abort / Continue / Skip in the command palette and menus.
    const updateContext = () => {
      const busy = ctx.repos.repositories.find(r => r.detectOperation() !== 'none');
      void vscode.commands.executeCommand('setContext', 'ideagittool.operation', busy?.detectOperation() ?? 'none');
    };
    ctx.repos.onDidChangeRepository(updateContext, null, this.disposables);
    ctx.repos.onDidChangeRepositories(updateContext, null, this.disposables);
    updateContext();
  }

  private schedulePush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      this.ctx.commitView?.post('branches', await this.state());
    }, 100);
  }

  async state(): Promise<BranchesState> {
    await this.ctx.repos.ready();
    const repos = this.ctx.repos.repositories;
    const cfg = settings();
    const sync = syncControl(this.ctx);
    const out: BranchesRepo[] = await Promise.all(
      repos.map(async r => ({
        root: r.root,
        name: r.name,
        branch: r.info.branch,
        operation: r.detectOperation(),
        recent: await recentBranches(r),
        refs: r.refs.filter(x => x.type !== 'HEAD' && x.type !== 'stash').map(toBranchRef),
      })),
    );
    let common: BranchRef[] = [];
    if (sync && repos.length > 1) {
      const first = out[0];
      const has = (repo: BranchesRepo, ref: BranchRef) => repo.refs.some(x => x.type === ref.type && x.name === ref.name);
      common = first.refs
        .filter(ref => out.every(repo => has(repo, ref)))
        .map(ref => ({
          ...ref,
          current: ref.type === 'local' && out.every(repo => repo.branch === ref.name),
          favorite: out.every(repo => repo.refs.some(x => x.fullName === ref.fullName && x.favorite)),
          ahead: undefined,
          behind: undefined,
        }));
    }
    return {
      mac: MAC,
      repos: out,
      sync,
      common,
      top: topActionModel(
        out.map(r => r.operation),
        MAC,
      ),
      settings: {
        groupByDirectory: cfg.get<boolean>('branches.groupByDirectory', true),
        groupByRepository: cfg.get<boolean>('branches.groupByRepository', true),
        showRecent: cfg.get<boolean>('branches.showRecent', true),
        showTags: cfg.get<boolean>('branches.showTags', true),
        searchActions: cfg.get<boolean>('branches.searchActions', true),
        syncControl: cfg.get<boolean>('branches.syncControl', true),
      },
      fetching: this.fetching,
    };
  }

  /** Repository and ref of a request; refs of the common (synchronous) section resolve in the first repository. */
  private resolve(p: RefAddress): { repo: Repository; ref: Ref; roots?: string[] } {
    const repos = this.ctx.repos.repositories;
    const repo = p.root ? this.ctx.repos.get(p.root) : repos[0];
    if (!repo) throw new Error('The repository is not available any more');
    const ref = repo.refs.find(r => r.name === p.name && r.type === p.type);
    if (!ref) throw new Error(`${p.type === 'tag' ? 'Tag' : 'Branch'} ${p.name} not found`);
    return { repo, ref, roots: p.root ? undefined : repos.map(r => r.root) };
  }

  private async refActions(p: RefAddress) {
    const { repo, ref, roots } = this.resolve(p);
    const current = roots ? roots.every(root => this.ctx.repos.get(root)?.info.branch === ref.name) : ref.current;
    return refActionsFor(repo, { ...ref, current: ref.type === 'local' && current }, { sync: !!roots, mac: MAC });
  }

  private async runRef(p: RefAddress & { action: string }) {
    const { repo, ref, roots } = this.resolve(p);
    await runRefAction(this.ctx, repo, ref, p.action, roots);
  }

  private async runTop(action: string) {
    const repo = activeRepo(this.ctx);
    const sync = syncControl(this.ctx);
    switch (action) {
      case 'ideagittool.createBranch':
        return sync ? newBranchCommand(this.ctx, { roots: this.ctx.repos.repositories.map(r => r.root) }) : newBranchCommand(this.ctx, repo ? { root: repo.root } : undefined);
      case 'ideagittool.checkoutTagOrRevision':
        return vscode.commands.executeCommand(action, repo ? { root: repo.root } : undefined);
      case 'ideagittool.abortOperation':
      case 'ideagittool.continueOperation':
      case 'ideagittool.skipCommit': {
        // The repository with the operation in progress.
        const busy = this.ctx.repos.repositories.find(r => r.detectOperation() !== 'none');
        return vscode.commands.executeCommand(action, busy ? { root: busy.root } : undefined);
      }
      default:
        return vscode.commands.executeCommand(action);
    }
  }

  private async toggleFavorite(p: RefAddress) {
    const repos = p.root ? [this.ctx.repos.get(p.root)].filter((r): r is Repository => !!r) : this.ctx.repos.repositories;
    const fullName = this.resolve(p).ref.fullName;
    // In the common section, all repositories follow the first one.
    const target = !repos[0]?.getFavoriteBranches().includes(fullName);
    for (const repo of repos) {
      if (repo.getFavoriteBranches().includes(fullName) !== target) await this.ctx.repos.toggleFavorite(repo, fullName);
    }
    this.schedulePush();
  }

  private async fetchAll() {
    if (this.fetching) return;
    this.fetching = true;
    this.schedulePush();
    try {
      await withProgress(
        'Fetching…',
        async (progress, token) => {
          for (const r of this.ctx.repos.repositories) await fetch(r, 'all', { progress, token });
        },
        { location: 'window' },
      );
      await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
    } finally {
      this.fetching = false;
      this.schedulePush();
    }
  }

  private async setSetting(key: string, value: boolean) {
    const allowed = ['groupByDirectory', 'groupByRepository', 'showRecent', 'showTags', 'searchActions', 'syncControl'];
    if (!allowed.includes(key)) throw new Error(`Unknown setting ${key}`);
    await settings().update(`branches.${key}`, value, vscode.ConfigurationTarget.Global);
    this.schedulePush();
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    if (this.timer) clearTimeout(this.timer);
  }
}

