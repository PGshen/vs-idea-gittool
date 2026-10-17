import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from './exec';
import { Repository } from './repository';

/**
 * Finds and tracks git repositories (VCS roots) in the workspace.
 */
export class RepositoryManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repository>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reposEmitter = new vscode.EventEmitter<void>();
  /** Fired when the set of repositories changes. */
  readonly onDidChangeRepositories = this.reposEmitter.event;
  private readonly anyEmitter = new vscode.EventEmitter<{ repo: Repository; status: boolean; refs: boolean }>();
  /** Fired when any repository changes. */
  readonly onDidChangeRepository = this.anyEmitter.event;
  private scanning: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.scan(), null, this.disposables);
  }

  get repositories(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  /** Scans the workspace for repositories. */
  scan(): Promise<void> {
    this.scanning = this.doScan();
    return this.scanning;
  }

  async ready(): Promise<void> {
    await (this.scanning ?? this.scan());
  }

  private async doScan() {
    const depth = vscode.workspace.getConfiguration('rebased').get<number>('repositoryScanMaxDepth', 1);
    const found = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const top = await this.findTopLevel(folder.uri.fsPath);
      if (top) found.add(top);
      for (const nested of findNestedGitDirs(folder.uri.fsPath, depth)) found.add(nested);
    }
    let changed = false;
    for (const root of found) {
      if (!this.repos.has(root)) {
        await this.open(root, false);
        changed = true;
      }
    }
    for (const [root, repo] of this.repos) {
      if (!found.has(root)) {
        repo.dispose();
        this.repos.delete(root);
        changed = true;
      }
    }
    if (changed) this.reposEmitter.fire();
  }

  private async findTopLevel(dir: string): Promise<string | undefined> {
    const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFailure: true, quiet: true }).catch(() => undefined);
    if (!r || r.exitCode !== 0) return undefined;
    return path.normalize(r.stdout.trim());
  }

  /** Opens a repository by root path (used after clone / init too). */
  async open(root: string, fire = true): Promise<Repository | undefined> {
    root = path.normalize(root);
    const existing = this.repos.get(root);
    if (existing) return existing;
    const r = await git(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: root, allowFailure: true, quiet: true });
    if (r.exitCode !== 0) return undefined;
    const [gitDir, commonDirRaw] = r.stdout.trim().split('\n');
    const commonDir = path.resolve(root, commonDirRaw);
    const repo = new Repository(root, gitDir, commonDir);
    repo.getFavoriteBranches = () => this.context.workspaceState.get<string[]>(`favorites:${root}`, ['refs/heads/main', 'refs/heads/master']);
    repo.onDidChange(e => this.anyEmitter.fire({ repo, ...e }));
    this.repos.set(root, repo);
    await repo.refresh();
    if (fire) this.reposEmitter.fire();
    return repo;
  }

  async toggleFavorite(repo: Repository, fullName: string) {
    const key = `favorites:${repo.root}`;
    const list = new Set(repo.getFavoriteBranches());
    if (list.has(fullName)) list.delete(fullName);
    else list.add(fullName);
    await this.context.workspaceState.update(key, [...list]);
    await repo.refresh();
  }

  get(root: string): Repository | undefined {
    return this.repos.get(path.normalize(root));
  }

  /** Finds the repository that contains a file. */
  getForFile(file: string): Repository | undefined {
    const abs = path.normalize(file);
    let best: Repository | undefined;
    for (const repo of this.repos.values()) {
      const rel = path.relative(repo.root, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || repo.root.length > best.root.length)) best = repo;
    }
    return best;
  }

  /**
   * Picks the repository to act on: the one of the active editor, the only one, or asks the user.
   */
  async pick(placeHolder = 'Select a Git repository'): Promise<Repository | undefined> {
    await this.ready();
    const repos = this.repositories;
    if (repos.length === 0) {
      void vscode.window.showWarningMessage('No Git repository found in the workspace.');
      return undefined;
    }
    if (repos.length === 1) return repos[0];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      const r = this.getForFile(active.fsPath);
      if (r) return r;
    }
    const picked = await vscode.window.showQuickPick(
      repos.map(r => ({ label: r.name, description: r.info.branch ?? r.info.headHash?.slice(0, 8), detail: r.root, repo: r })),
      { placeHolder },
    );
    return picked?.repo;
  }

  dispose() {
    this.repos.forEach(r => r.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

function findNestedGitDirs(dir: string, depth: number): string[] {
  const out: string[] = [];
  if (depth <= 0) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const sub = path.join(dir, e.name);
    if (fs.existsSync(path.join(sub, '.git'))) out.push(path.normalize(sub));
    out.push(...findNestedGitDirs(sub, depth - 1));
  }
  return out;
}
