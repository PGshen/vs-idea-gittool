import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { LONG_EDGE_SIZE, visualizeRow } from '../../git/graph';
import { Repository } from '../../git/repository';
import { openChangeDiff, openMultiDiff, REV_EMPTY, toGitUri } from '../../host/gitContent';
import { showDialog } from '../../host/dialog';
import { WebviewConnection } from '../../host/webviewHost';
import {
  ContextInfo,
  DEFAULT_LOG_SETTINGS,
  DetailsResult,
  FileDiffResult,
  LogInit,
  LogMode,
  LogRepo,
  LogUiSettings,
  RefreshEvent,
  RowData,
  RowsResult,
  SignatureInfo,
} from '../../shared/logProtocol';
import { Change, Ref } from '../../shared/types';
import { containingBranches, EMPTY_TREE, loadChanges, loadChangesToParents, loadDetails, parseNameStatus } from './details';
import { fileDiff } from './fileDiff';
import { EMPTY_FILTERS, filtersTitle, LogFilters, LogOptions } from './filters';
import { addCommitsToRemoteBranch, dropSelectedChanges, EditResult, extractSelectedChanges, InMemoryError, MergeConflictError, undoEdit } from './inMemory';
import { LogModel } from './model';

const SETTINGS_KEY = 'rebased.log.ui';

export function getLogSettings(ctx: Ctx): LogUiSettings {
  const s = ctx.extension.globalState.get<Partial<LogUiSettings>>(SETTINGS_KEY, {});
  return { ...DEFAULT_LOG_SETTINGS, ...s, columns: { ...DEFAULT_LOG_SETTINGS.columns, ...s.columns }, columnWidths: { ...DEFAULT_LOG_SETTINGS.columnWidths, ...s.columnWidths } };
}

/** Every open tab, so that settings changes reach all of them. */
const allTabs = new Set<LogTab>();

export interface LogTabState {
  root: string;
  mode: LogMode;
  filters: LogFilters;
  options: LogOptions;
  compare?: { ref: string; with: string };
  select?: string;
  /** Show all repositories of the workspace in one log (multi-root log). */
  multi?: boolean;
}

let tabCounter = 0;

/**
 * Host side of one log tab (main log, extra tab, file history or branch comparison).
 */
export class LogTab implements vscode.Disposable {
  readonly id = `log${++tabCounter}`;
  private model: LogModel;
  private repo: Repository;
  private readonly disposables: vscode.Disposable[] = [];
  private conn: WebviewConnection | undefined;
  private me = { name: '', email: '' };
  private onTitleEmitter = new vscode.EventEmitter<string>();
  readonly onTitle = this.onTitleEmitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  /** In-flight model reset; row requests wait for it so that rows of two generations never mix. */
  private resetting: Promise<void> | undefined;

  constructor(
    private readonly ctx: Ctx,
    repo: Repository,
    public state: LogTabState,
    private readonly persistKey?: string,
  ) {
    this.repo = repo;
    this.model = new LogModel(this.tabRepos());
    allTabs.add(this);
    ctx.repos.onDidChangeRepository(
      e => {
        if (!e.refs || !this.model.repositories.includes(e.repo)) return;
        // Debounce: a rebase moves HEAD many times.
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), 400);
      },
      null,
      this.disposables,
    );
    ctx.repos.onDidChangeRepositories(
      () => {
        if (!this.state.multi) return;
        this.model.setRepositories(this.tabRepos());
        void this.refresh();
      },
      null,
      this.disposables,
    );
  }

  /** Repositories shown by this tab. */
  private tabRepos(): Repository[] {
    if (!this.state.multi) return [this.repo];
    const all = this.ctx.repos.repositories;
    return all.length ? [this.repo, ...all.filter(r => r !== this.repo)] : [this.repo];
  }

  private get multi() {
    return !!this.state.multi && this.model.repositories.length > 1;
  }

  get title(): string {
    if (this.state.mode === 'history') return `History: ${filtersTitle(this.state.filters)}`;
    if (this.state.mode === 'compare' && this.state.compare) return `${this.state.compare.ref} vs ${this.state.compare.with}`;
    const t = filtersTitle(this.state.filters);
    return t ? `Log: ${t}` : 'Log';
  }

  get root() {
    return this.repo.root;
  }

  /** Repository of a commit shown in this tab. */
  private repoOf(hash: string | undefined): Repository {
    if (!hash || !this.multi) return this.repo;
    const root = this.model.rootOf(hash);
    return (root && this.ctx.repos.get(root)) || this.repo;
  }

  private repoByRoot(root: string | undefined): Repository {
    return (root && this.model.repositories.find(r => r.root === root)) || this.repo;
  }

  /** Attaches the webview (panel or view). */
  attach(webview: vscode.Webview) {
    this.conn?.dispose();
    const conn = new WebviewConnection(webview, 'log', () => this.initData(), this.title);
    this.conn = conn;
    conn.handleAll({
      rows: (p: { start: number; count: number }) => this.rows(p.start, p.count),
      setFilters: (p: { filters: LogFilters; options: LogOptions }) => this.setFilters(p.filters, p.options),
      details: (p: { hashes: string[]; toParents?: boolean }) => this.details(p.hashes, p.toParents),
      containing: (hash: string) => this.containing(hash),
      contextInfo: (hashes: string[]) => this.contextInfo(hashes),
      saveSettings: (s: LogUiSettings) => this.saveSettings(s),
      authors: () => this.authors(),
      find: (q: string) => this.find(q),
      commitAction: (p: { id: string; hashes: string[]; arg?: string }) => this.commitAction(p.id, p.hashes, p.arg),
      changeAction: (p: { id: string; changes: Change[]; left: string; right: string; hashes: string[] }) => this.changeAction(p.id, p.changes, p.left, p.right, p.hashes),
      branchAction: (p: { id: string; name: string; type: string; root?: string }) => this.branchAction(p.id, p.name, p.type, p.root),
      command: (p: { id: string; args?: unknown }) => vscode.commands.executeCommand(p.id, p.args),
      pickPaths: () => this.pickPaths(),
      pickDate: (p: { which: 'since' | 'until' }) => this.pickDate(p.which),
      pickBranches: () => this.pickBranches(),
      copy: (text: string) => vscode.env.clipboard.writeText(text),
      newTab: (p?: { filters?: LogFilters }) => vscode.commands.executeCommand('rebased.log.newTab', { root: this.repo.root, filters: p?.filters, multi: this.state.multi }),
      input: (p: { title: string; prompt?: string; value?: string }) => vscode.window.showInputBox({ title: p.title, prompt: p.prompt, value: p.value }),
      refreshRepo: () => Promise.all(this.model.repositories.map(r => r.refresh())),
      openUrl: (url: string) => vscode.env.openExternal(vscode.Uri.parse(url)),
      signatures: (hashes: string[]) => this.signatures(hashes),
      cherryPicked: (p: { branch: string }) => this.cherryPicked(p.branch),
      myBranches: () => this.myBranches(),
      fileDiff: (p: { change: Change; left: string; right: string; context: number }) => this.fileDiff(p.change, p.left, p.right, p.context),
    });
    return conn;
  }

  private repoInfos(): LogRepo[] {
    return this.model.repositories.map((r, i) => ({
      root: r.root,
      name: r.name,
      head: { branch: r.info.branch, hash: r.info.headHash, detached: r.info.detached, operation: r.info.operation },
      color: i,
    }));
  }

  private allRefs(): Ref[] {
    if (!this.multi) return this.repo.refs;
    return this.model.repositories.flatMap(r => r.refs.map(ref => ({ ...ref, root: r.root })));
  }

  private head() {
    return { branch: this.repo.info.branch, hash: this.repo.info.headHash, detached: this.repo.info.detached, operation: this.repo.info.operation };
  }

  private initData(): LogInit {
    return {
      tabId: this.id,
      mode: this.state.mode,
      title: this.title,
      repos: this.repoInfos(),
      multi: this.multi,
      root: this.repo.root,
      refs: this.allRefs(),
      head: this.head(),
      filters: this.state.filters,
      options: this.state.options,
      settings: getLogSettings(this.ctx),
      me: this.me,
      compare: this.state.compare,
      select: this.state.select,
    };
  }

  async start() {
    const name = (await this.repo.getConfig('user.name')) ?? '';
    const email = (await this.repo.getConfig('user.email')) ?? '';
    this.me = { name, email };
    await this.reset();
  }

  private reset(): Promise<void> {
    const p = this.model.reset(this.state.filters, this.state.options, this.meAuthors());
    this.resetting = p;
    void p.finally(() => {
      if (this.resetting === p) this.resetting = undefined;
    });
    return p;
  }

  private meAuthors() {
    return [this.me.email || this.me.name].filter(Boolean);
  }

  private toRow(i: number, showLongEdges: boolean): RowData {
    const { commit: c, graph, inHead } = this.model.rows[i];
    const g = visualizeRow(graph, i, this.model.segments, showLongEdges);
    const row: RowData = { h: c.hash, p: c.parents, s: c.subject, an: c.authorName, ae: c.authorEmail, at: c.authorDate, cn: c.committerName, ct: c.commitDate, refs: c.refs, g, b: inHead };
    if (this.multi) row.r = this.model.repositories.findIndex(r => r.root === c.root);
    return row;
  }

  async rows(start: number, count: number): Promise<RowsResult> {
    while (this.resetting) await this.resetting;
    const gen = this.model.generation;
    const showLongEdges = getLogSettings(this.ctx).showLongEdges;
    // Load ahead so that the length of edges near the requested rows is known (long edges are cut).
    await this.model.ensure(start + count + (showLongEdges ? 1000 : LONG_EDGE_SIZE) + 3);
    if (gen !== this.model.generation) return this.rows(start, count);
    const end = Math.min(this.model.rows.length, start + count);
    const rows: RowData[] = [];
    for (let i = start; i < end; i++) rows.push(this.toRow(i, showLongEdges));
    return { start, rows, total: this.model.rows.length, done: this.model.done, error: this.model.error, gen };
  }

  async setFilters(filters: LogFilters, options: LogOptions) {
    this.state = { ...this.state, filters, options };
    this.persist();
    await this.reset();
    this.onTitleEmitter.fire(this.title);
    return { total: this.model.rows.length, done: this.model.done, title: this.title, gen: this.model.generation, hidden: this.model.hiddenCount };
  }

  private persist() {
    if (this.persistKey) void this.ctx.extension.workspaceState.update(this.persistKey, { filters: this.state.filters, options: this.state.options });
  }

  async refresh() {
    this.historyPaths = undefined;
    await this.reset();
    const event: RefreshEvent = {
      refs: this.allRefs(),
      head: this.head(),
      repos: this.repoInfos(),
      total: this.model.rows.length,
      done: this.model.done,
      gen: this.model.generation,
    };
    this.conn?.post('refresh', event);
  }

  /** Selects a commit in this tab (navigates). Returns false when not found in the log. */
  async select(hash: string): Promise<boolean> {
    const i = await this.findIndex(hash);
    if (i < 0) return false;
    this.conn?.post('select', { hash: this.model.rows[i].commit.hash, index: i, total: this.model.rows.length });
    return true;
  }

  /** Finds a commit; expands collapsed linear branches when the commit is hidden by them. */
  private async findIndex(hash: string): Promise<number> {
    let i = await this.model.find(hash);
    if (i < 0 && this.state.options.collapseLinear && this.model.isHidden(hash)) {
      await this.setFilters(this.state.filters, { ...this.state.options, collapseLinear: false });
      this.conn?.post('optionsChanged', { options: this.state.options, total: this.model.rows.length, done: this.model.done, gen: this.model.generation });
      i = await this.model.find(hash);
    }
    return i;
  }

  private groupByRepo(hashes: string[]): Map<Repository, string[]> {
    const groups = new Map<Repository, string[]>();
    for (const h of hashes) {
      const repo = this.repoOf(h);
      groups.set(repo, [...(groups.get(repo) ?? []), h]);
    }
    return groups;
  }

  private async details(hashes: string[], toParents?: boolean): Promise<DetailsResult> {
    const ordered = [...hashes].sort((a, b) => this.model.indexOf(a) - this.model.indexOf(b));
    const parentsOf = (h: string) => this.model.rows[this.model.indexOf(h)]?.commit.parents;
    const groups = this.groupByRepo(ordered);
    if (groups.size > 1) {
      const details = [];
      const changes: Change[] = [];
      const revs: Record<string, { left: string; right: string }> = {};
      for (const [repo, list] of groups) {
        details.push(...(await loadDetails(repo, list.slice(0, 50))));
        const r = await loadChanges(repo, list, parentsOf);
        changes.push(...r.changes);
        revs[repo.root] = { left: r.left, right: r.right };
      }
      details.sort((a, b) => this.model.indexOf(a.hash) - this.model.indexOf(b.hash));
      const first = revs[this.repoOf(ordered[0]).root];
      return { details, changes, left: first.left, right: first.right, revs };
    }
    const repo = this.repoOf(ordered[0]);
    const details = await loadDetails(repo, ordered.slice(0, 50));
    const { changes, left, right } = await loadChanges(repo, ordered, parentsOf);
    let toParentsResult: DetailsResult['toParents'];
    const single = ordered.length === 1 ? parentsOf(ordered[0]) : undefined;
    if (toParents && single && single.length > 1) toParentsResult = await loadChangesToParents(repo, ordered[0], single);
    return { details, changes, left, right, toParents: toParentsResult };
  }

  private async containing(hash: string): Promise<string[]> {
    const repo = this.repoOf(hash);
    const branches = await containingBranches(repo, hash);
    const inHead = await repo.exec(['merge-base', '--is-ancestor', hash, 'HEAD'], { allowFailure: true, quiet: true });
    if (inHead.exitCode === 0) branches.unshift('HEAD');
    return branches;
  }

  private async contextInfo(hashes: string[]): Promise<ContextInfo> {
    const repo = this.repoOf(hashes[0]);
    const mixedRoots = this.groupByRepo(hashes).size > 1;
    const isAncestor = async (a: string, b: string) => (await repo.exec(['merge-base', '--is-ancestor', a, b], { allowFailure: true, quiet: true })).exitCode === 0;
    let inHead = !repo.info.empty && !mixedRoots;
    let pushed = false;
    let hasMerges = false;
    for (const h of hashes) {
      if (inHead && !(await isAncestor(h, 'HEAD'))) inHead = false;
      if (!mixedRoots && repo.info.upstream && (await isAncestor(h, '@{upstream}'))) pushed = true;
      if ((this.model.rows[this.model.indexOf(h)]?.commit.parents.length ?? 0) > 1) hasMerges = true;
    }
    const refs = hashes.length === 1 ? repo.refs.filter(r => r.hash === hashes[0]).map(r => ({ ...r, root: repo.root })) : [];
    return {
      inHead,
      pushed,
      hasMerges,
      isHead: hashes.length === 1 && hashes[0] === repo.info.headHash,
      refs,
      webUrl: hashes.length === 1 ? webCommitUrl(repo, hashes[0]) : undefined,
      operation: repo.info.operation,
      mixedRoots,
      hasRemoteBranches: repo.refs.some(r => r.type === 'remote'),
    };
  }

  private async saveSettings(s: LogUiSettings) {
    await this.ctx.extension.globalState.update(SETTINGS_KEY, s);
    for (const t of allTabs) if (t !== this) t.conn?.post('settings', s);
  }

  private async authors(): Promise<string[]> {
    const seen = new Set<string>();
    for (const repo of this.model.repositories) {
      const out = await repo.execText(['shortlog', '-sne', '--all', '--no-merges', '-n'], { allowFailure: true, quiet: true, input: '' });
      for (const l of out.split('\n')) {
        const a = l.replace(/^\s*\d+\s+/, '').trim();
        if (a) seen.add(a);
      }
    }
    return [...seen].slice(0, 300);
  }

  private async find(q: string): Promise<{ index: number; hash: string } | undefined> {
    let hash: string | undefined;
    for (const repo of this.model.repositories) {
      const ref = repo.refs.find(r => r.name === q || r.fullName === q);
      hash = ref?.hash;
      if (!hash) {
        const r = await repo.exec(['rev-parse', '-q', '--verify', `${q}^{commit}`], { allowFailure: true, quiet: true });
        if (r.exitCode === 0) hash = r.stdout.trim();
      }
      if (hash) break;
    }
    if (!hash) {
      void vscode.window.showWarningMessage(`${q} not found`);
      return undefined;
    }
    const i = await this.findIndex(hash);
    if (i < 0) {
      const pick = await vscode.window.showWarningMessage(`Commit or reference '${q}' doesn't match the filters`, 'View and reset filters', 'View in new tab');
      if (pick === 'View and reset filters') {
        await this.setFilters({ ...EMPTY_FILTERS }, this.state.options);
        this.conn?.post('filtersReset', { filters: this.state.filters });
        const j = await this.model.find(hash);
        return j >= 0 ? { index: j, hash } : undefined;
      }
      if (pick === 'View in new tab') await vscode.commands.executeCommand('rebased.log.selectCommit', { root: this.repo.root, hash, newTab: true });
      return undefined;
    }
    return { index: i, hash: this.model.rows[i].commit.hash };
  }

  // ------------------------------------------------------------------ highlighters and columns

  private signatureCache = new Map<string, SignatureInfo>();

  /** GPG Signature column: %G? for the visible commits, loaded lazily like IntelliJ. */
  private async signatures(hashes: string[]): Promise<Record<string, SignatureInfo>> {
    const out: Record<string, SignatureInfo> = {};
    const missing = hashes.filter(h => {
      const c = this.signatureCache.get(h);
      if (c) out[h] = c;
      return !c;
    });
    for (const [repo, list] of this.groupByRepo(missing)) {
      const text = await repo.execText(['show', '-s', '--format=%H%x00%G?%x00%GS%x00%GK%x01', ...list, '--'], { quiet: true, allowFailure: true });
      for (const rec of text.split('\x01')) {
        const [h, status, signer, key] = rec.replace(/^\n/, '').split('\0');
        if (!h || !status) continue;
        const info: SignatureInfo = { status, signer: signer || undefined, key: key || undefined };
        this.signatureCache.set(h, info);
        out[h] = info;
      }
    }
    return out;
  }

  /**
   * Not Cherry-Picked Commits highlighter: commits of `branch` whose changes are not in the current
   * branch yet (`git cherry`-like comparison by patch id). Returns those hashes; the other commits are dimmed.
   */
  private async cherryPicked(branch: string): Promise<{ nonPicked: string[] }> {
    const nonPicked: string[] = [];
    for (const repo of this.model.repositories) {
      if (!repo.refs.some(r => r.name === branch || r.fullName === branch)) continue;
      const target = repo.info.branch ?? 'HEAD';
      const out = await repo.execText(['rev-list', '--cherry-pick', '--right-only', '--no-merges', `${target}...${branch}`], { quiet: true });
      nonPicked.push(...out.split('\n').filter(Boolean));
    }
    return { nonPicked };
  }

  /** Show My Branches: local branches whose exclusive commits are all made by the current Git author. */
  private async myBranches(): Promise<string[]> {
    const mine: string[] = [];
    for (const repo of this.model.repositories) {
      const email = (await repo.getConfig('user.email')) ?? this.me.email;
      const name = (await repo.getConfig('user.name')) ?? this.me.name;
      for (const ref of repo.refs.filter(r => r.type === 'local')) {
        const args = ['log', '--format=%ae%x00%an', ref.fullName, '--not', `--exclude=${ref.fullName}`];
        if (ref.upstream) args.push(`--exclude=refs/remotes/${ref.upstream}`);
        args.push('--branches', '--remotes', '--tags', '--');
        const out = await repo.execText(args, { quiet: true, allowFailure: true });
        const authors = out.split('\n').filter(Boolean);
        if (authors.length && authors.every(a => a.split('\0')[0] === email || a.split('\0')[1] === name)) mine.push(this.multi ? `${repo.root}\0${ref.fullName}` : ref.fullName);
      }
    }
    return mine;
  }

  private fileDiff(change: Change, left: string, right: string, context: number): Promise<FileDiffResult> {
    const repo = this.repoByRoot(change.root);
    return fileDiff(repo, change, left === REV_EMPTY ? EMPTY_TREE : left, right, context);
  }

  // ------------------------------------------------------------------ actions

  private async commitAction(id: string, hashes: string[], arg?: string) {
    const repo = this.repoOf(hashes[0]);
    const root = repo.root;
    const ordered = [...hashes].sort((a, b) => this.model.indexOf(a) - this.model.indexOf(b));
    const run = (cmd: string, args: unknown) => vscode.commands.executeCommand(cmd, args);
    switch (id) {
      case 'copy':
        return vscode.env.clipboard.writeText(ordered.join(' '));
      case 'createPatch':
        return run('rebased.createPatch', { root, hashes: ordered });
      case 'cherryPick':
        // Oldest first.
        return run('rebased.cherryPick', { root, hashes: [...ordered].reverse() });
      case 'checkoutRevision':
        return run('rebased.checkoutRevision', { root, hash: ordered[0] });
      case 'checkoutBranch':
        return run('rebased.branch.checkout', { root, name: arg, type: arg?.includes('/') && repo.refs.some(r => r.type === 'remote' && r.name === arg) ? 'remote' : 'local' });
      case 'showRepositoryAtRevision':
        return run('rebased.showRepositoryAtRevision', { root, hash: ordered[0] });
      case 'compareVersions': {
        const [a, b] = [ordered[ordered.length - 1], ordered[0]];
        return this.compareCommits(repo, a, b);
      }
      case 'compareWithLocal':
        return this.compareWithLocal(repo, ordered[0]);
      case 'reset':
        return run('rebased.resetHead', { root, hash: ordered[0] });
      case 'revert':
        return run('rebased.revertCommits', { root, hashes: ordered });
      case 'undo':
        return run('rebased.undoCommit', { root, hash: ordered[ordered.length - 1] });
      case 'reword':
        return run('rebased.rewordCommit', { root, hash: ordered[0] });
      case 'fixup':
        return run('rebased.fixupCommit', { root, hash: ordered[0] });
      case 'squashInto':
        return run('rebased.fixupCommit', { root, hash: ordered[0], squash: true });
      case 'drop':
        return run('rebased.dropCommits', { root, hashes: ordered });
      case 'squash':
        return run('rebased.squashCommits', { root, hashes: ordered });
      case 'interactiveRebase':
        return run('rebased.interactiveRebase', { root, hash: ordered[0] });
      case 'pushUpTo':
        return run('rebased.push', { root, upTo: ordered[0] });
      case 'addToRemote':
        return this.addToRemoteBranch(repo, [...ordered].reverse());
      case 'newBranch':
        return run('rebased.createBranch', { root, startPoint: ordered[0] });
      case 'newTag':
        return run('rebased.createTag', { root, hash: ordered[0] });
      case 'showDiff':
        return this.showCommitDiff(ordered);
      case 'showInLog':
        return run('rebased.log.selectCommit', { root, hash: ordered[0] });
      case 'historyGet':
      case 'historyShowFile':
      case 'historyCompareWithLocal':
      case 'historyDiff':
      case 'historyAnnotate':
        return this.historyAction(id, ordered);
      case 'openInBrowser': {
        const url = webCommitUrl(repo, ordered[0]);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
    }
  }

  /** Add Commits to Remote Branch… (GitAddCommitToRemoteBranchAction): pick a remote branch, cherry-pick in memory, push. */
  private async addToRemoteBranch(repo: Repository, oldestFirst: string[]) {
    const remotes = repo.refs.filter(r => r.type === 'remote');
    const picked = await vscode.window.showQuickPick(
      remotes.map(r => ({ label: r.name, description: r.name === repo.info.upstream ? 'tracked' : undefined, ref: r })),
      { title: `Select Remote Branch for ${oldestFirst.length === 1 ? 'Commit' : 'Commits'}`, placeHolder: 'Search remote branches', matchOnDescription: true },
    );
    if (!picked) return;
    const remote = picked.ref.remote ?? picked.ref.name.split('/')[0];
    const branch = picked.ref.name.slice(remote.length + 1);
    const n = oldestFirst.length;
    try {
      const tip = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Adding ${n === 1 ? 'commit' : 'commits'} to ${branch}`, cancellable: false },
        p => addCommitsToRemoteBranch(repo, oldestFirst, remote, branch, text => p.report({ message: text })),
      );
      if (!tip) {
        void vscode.window.showInformationMessage(`Nothing to add: All selected commits are already present on ${picked.ref.name}`);
        return;
      }
      const ok = await vscode.window.showInformationMessage(
        `Push ${n} ${n === 1 ? 'commit' : 'commits'} to ${remote} : ${branch}?`,
        { modal: true, detail: `${tip.slice(0, 8)} will become the new head of ${picked.ref.name}.` },
        'Push',
      );
      if (ok !== 'Push') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing to ${remote}/${branch}…` }, () =>
        repo.exec(['push', '--porcelain', remote, `${tip}:refs/heads/${branch}`]),
      );
      await repo.exec(['fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { allowFailure: true });
      await repo.refresh();
      void vscode.window.showInformationMessage(`Pushed ${n} ${n === 1 ? 'commit' : 'commits'} to ${remote}/${branch}`);
    } catch (e) {
      if (e instanceof MergeConflictError) void vscode.window.showErrorMessage(`Cherry-pick conflict: Failed to cherry-pick commits onto ${picked.ref.name}:\n${e.files.join('\n')}`);
      else void vscode.window.showErrorMessage(`Add to remote branch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private historyPaths: Map<string, { path: string; oldPath?: string; status: string }> | undefined;

  /** File path at each revision of a file history (follows renames). */
  private async pathsInHistory() {
    if (this.historyPaths) return this.historyPaths;
    const file = this.state.filters.lines?.path ?? this.state.filters.paths[0];
    const map = new Map<string, { path: string; oldPath?: string; status: string }>();
    const out = await this.repo.execText(['log', '--follow', '--name-status', '-z', '--format=%x01%H', 'HEAD', '--', file], { quiet: true, allowFailure: true });
    for (const rec of out.split('\x01').filter(Boolean)) {
      const [head, ...rest] = rec.split('\0').map(s => s.replace(/^\n/, ''));
      const status = rest[0]?.[0] ?? 'M';
      if (status === 'R' || status === 'C') map.set(head.trim(), { status, oldPath: rest[1], path: rest[2] });
      else map.set(head.trim(), { status, path: rest[1] ?? file });
    }
    this.historyPaths = map;
    return map;
  }

  private async historyAction(id: string, ordered: string[]) {
    const root = this.repo.root;
    const file = this.state.filters.lines?.path ?? this.state.filters.paths[0];
    const paths = await this.pathsInHistory();
    const at = (h: string) => paths.get(h) ?? { path: file, status: 'M' };
    const hash = ordered[0];
    const info = at(hash);
    const change: Change = { root, path: info.path, oldPath: info.oldPath, status: info.status as Change['status'] };
    switch (id) {
      case 'historyGet': {
        const ok = await vscode.window.showWarningMessage(`Get revision ${hash.slice(0, 8)} of ${info.path}? Local changes will be overwritten.`, { modal: true }, 'Get');
        if (ok) await this.repo.exec(['checkout', hash, '--', info.path]);
        return;
      }
      case 'historyShowFile':
        return vscode.window.showTextDocument(toGitUri(root, info.path, change.status === 'D' ? `${hash}^` : hash), { preview: false });
      case 'historyCompareWithLocal':
        return openChangeDiff({ ...change, oldPath: info.path !== file ? info.path : undefined, path: file, status: 'M' }, hash, 'WORKTREE');
      case 'historyAnnotate':
        return vscode.commands.executeCommand('rebased.annotateRevision', { root, hash, path: info.path });
      case 'historyDiff': {
        if (ordered.length >= 2) {
          const older = ordered[ordered.length - 1];
          return openChangeDiff({ root, path: info.path, oldPath: at(older).path !== info.path ? at(older).path : undefined, status: 'M' }, older, hash);
        }
        const parent = this.model.rows[this.model.indexOf(hash)]?.commit.parents[0];
        return openChangeDiff(change, parent ?? REV_EMPTY, hash);
      }
    }
  }

  async showCommitDiff(hashes: string[]) {
    const repo = this.repoOf(hashes[0]);
    const { changes, left, right } = await loadChanges(repo, hashes.filter(h => this.repoOf(h) === repo), h => this.model.rows[this.model.indexOf(h)]?.commit.parents);
    await openMultiDiff(`${right.slice(0, 8)}`, changes, () => left, () => right);
  }

  private async compareCommits(repo: Repository, older: string, newer: string) {
    const out = await repo.execText(['diff', '--name-status', '-z', '-M', older, newer, '--'], { quiet: true });
    const changes = parseNameStatus(repo.root, out);
    await openMultiDiff(`${older.slice(0, 8)} ↔ ${newer.slice(0, 8)}`, changes, () => older, () => newer);
  }

  private async compareWithLocal(repo: Repository, hash: string) {
    const out = await repo.execText(['diff', '--name-status', '-z', '-M', hash, '--'], { quiet: true });
    const changes = parseNameStatus(repo.root, out);
    if (!changes.length) {
      void vscode.window.showInformationMessage('No differences');
      return;
    }
    await openMultiDiff(`${hash.slice(0, 8)} ↔ Local`, changes, () => hash, () => 'WORKTREE');
  }

  private async changeAction(id: string, changes: Change[], left: string, right: string, hashes: string[]) {
    const repo = this.repoByRoot(changes[0]?.root);
    const root = repo.root;
    const leftRev = left === EMPTY_TREE ? REV_EMPTY : left;
    switch (id) {
      case 'diff':
        if (changes.length === 1) return openChangeDiff(changes[0], leftRev, right);
        return openMultiDiff(`${right.slice(0, 8)}`, changes, () => leftRev, () => right);
      case 'compareWithLocal':
        for (const c of changes) await openChangeDiff({ ...c, status: c.status === 'D' ? 'D' : 'M' }, right, 'WORKTREE', { preview: changes.length === 1 });
        return;
      case 'compareBeforeWithLocal':
        for (const c of changes) await openChangeDiff({ ...c, status: c.status === 'A' ? 'A' : 'M' }, leftRev, 'WORKTREE', { preview: changes.length === 1 });
        return;
      case 'editSource':
        for (const c of changes) if (c.status !== 'D') await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, c.path)), { preview: false });
        return;
      case 'openRepositoryVersion':
        for (const c of changes) await vscode.window.showTextDocument(toGitUri(root, c.status === 'D' ? (c.oldPath ?? c.path) : c.path, c.status === 'D' ? leftRev : right), { preview: false });
        return;
      case 'revertSelected':
      case 'applySelected': {
        const paths = changes.flatMap(c => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
        const diff = await repo.exec(['diff', '--binary', leftRev === REV_EMPTY ? EMPTY_TREE : left, right, '--', ...paths], { quiet: true });
        if (!diff.stdout.trim()) return;
        const args = ['apply', '--3way', '--whitespace=nowarn'];
        if (id === 'revertSelected') args.push('-R');
        const r = await repo.exec([...args, '-'], { input: diff.stdout, allowFailure: true });
        await repo.refresh();
        if (r.exitCode !== 0) {
          void vscode.window.showWarningMessage(`${id === 'revertSelected' ? 'Revert' : 'Cherry-pick'} of selected changes finished with conflicts: ${r.stderr.trim()}`);
          await vscode.commands.executeCommand('rebased.resolveConflicts', { root });
        } else void vscode.window.showInformationMessage(id === 'revertSelected' ? 'Selected changes reverted' : 'Selected changes applied');
        return;
      }
      case 'dropSelected':
        return this.dropSelected(repo, hashes[0], changes);
      case 'extractSelected':
        return this.extractSelected(repo, hashes[0], changes);
      case 'createPatch':
        return vscode.commands.executeCommand('rebased.createPatch', { root, hashes, changes });
      case 'get': {
        const answer = await vscode.window.showWarningMessage(`Get ${changes.length === 1 ? `'${changes[0].path}'` : `${changes.length} files`} from revision ${right.slice(0, 8)}? Local changes will be overwritten.`, { modal: true }, 'Get');
        if (answer !== 'Get') return;
        const existing = changes.filter(c => c.status !== 'D').map(c => c.path);
        const deleted = changes.filter(c => c.status === 'D').map(c => c.path);
        if (existing.length) await repo.exec(['checkout', right, '--', ...existing]);
        if (deleted.length) await repo.exec(['rm', '-f', '--ignore-unmatch', '--', ...deleted]);
        await repo.refresh();
        return;
      }
      case 'historyUpToHere':
        return vscode.commands.executeCommand('rebased.showFileHistory', { root, path: changes[0].path, revision: right });
      case 'copyPath':
        return vscode.env.clipboard.writeText(changes.map(c => c.path).join('\n'));
      case 'copyAbsolutePath':
        return vscode.env.clipboard.writeText(changes.map(c => path.join(c.root, c.path)).join('\n'));
    }
  }

  /** Drop Selected Changes (GitDropSelectedChangesAction). */
  private async dropSelected(repo: Repository, hash: string, changes: Change[]) {
    if (repo.info.operation !== 'none') {
      void vscode.window.showErrorMessage('Could Not Drop Selected Changes: Another operation is in progress');
      return;
    }
    await this.runEdit(repo, 'drop selected changes', 'Selected changes dropped', 'Could Not Drop Selected Changes', () => dropSelectedChanges(repo, hash, changes));
  }

  /** Extract Selected Changes to Separate Commit… (GitExtractSelectedChangesAction). */
  private async extractSelected(repo: Repository, hash: string, changes: Change[]) {
    if (repo.info.operation !== 'none') {
      void vscode.window.showErrorMessage('Could Not Extract Selected Changes: Another operation is in progress');
      return;
    }
    const all = (await this.details([hash])).changes;
    if (changes.length >= all.length) {
      void vscode.window.showWarningMessage('Unable to extract all changes from the commit');
      return;
    }
    const d = (await loadDetails(repo, [hash]))[0];
    const message = await showDialog<{ message: string }>(
      'log.newCommitMessage',
      { label: `Changes extracted from commit ${hash.slice(0, 8)} by ${d?.authorName ?? ''}`, message: d?.body ?? '', okText: 'OK' },
      { title: 'New Commit Message', validate: (v: { message: string }) => (v.message.trim() ? true : 'Specify commit message') },
    );
    if (!message) return;
    await this.runEdit(repo, 'extract selected changes', 'Changes extracted', 'Could Not Extract Selected Changes', () => extractSelectedChanges(repo, hash, changes, message.message));
  }

  private async runEdit(repo: Repository, operation: string, success: string, failure: string, fn: () => Promise<EditResult>) {
    let result: EditResult;
    try {
      result = await repo.batch(async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${operation[0].toUpperCase()}${operation.slice(1)}…` }, fn));
    } catch (e) {
      const msg = e instanceof InMemoryError || e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`${failure}: ${msg}`);
      return;
    }
    await this.refresh();
    void this.select(result.focus);
    const picked = await vscode.window.showInformationMessage(success, 'Undo');
    if (picked !== 'Undo') return;
    try {
      await repo.refresh();
      if (repo.info.headHash !== result.newHead) {
        void vscode.window.showErrorMessage(`Cannot undo ${operation}: the repository has changed`);
        return;
      }
      await repo.batch(() => undoEdit(repo, result, operation));
    } catch (e) {
      void vscode.window.showErrorMessage(`Undo ${operation} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private branchAction(id: string, name: string, type: string, root?: string) {
    if (id === 'filter') return; // handled in the webview
    return vscode.commands.executeCommand(`rebased.${type === 'tag' ? 'tag' : 'branch'}.${id}`, { root: root ?? this.repo.root, name, type });
  }

  private async pickPaths(): Promise<string[] | undefined> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(this.repo.root), openLabel: 'Select' });
    if (!uris) return undefined;
    // In a multi-root log paths are absolute; each repository gets the paths inside it.
    if (this.multi) return uris.map(u => u.fsPath);
    return uris.map(u => this.repo.relPath(u.fsPath)).filter(p => !p.startsWith('..'));
  }

  private async pickDate(which: 'since' | 'until'): Promise<number | undefined> {
    const v = await vscode.window.showInputBox({
      title: 'Select Period',
      prompt: which === 'since' ? 'Show commits made since (YYYY-MM-DD or "2 weeks ago")' : 'Show commits made until (YYYY-MM-DD)',
      placeHolder: new Date().toISOString().slice(0, 10),
      validateInput: s => (parseDate(s) === undefined ? 'Enter a date like 2026-06-01 or a relative period like "3 days ago"' : undefined),
    });
    return v === undefined ? undefined : parseDate(v);
  }

  private async pickBranches(): Promise<string[] | undefined> {
    const seen = new Set<string>();
    const items = this.allRefs()
      .filter(r => !seen.has(r.name) && seen.add(r.name))
      .map(r => ({ label: r.name, description: r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'remote' : 'local' }));
    const picked = await vscode.window.showQuickPick([{ label: 'HEAD', description: '' }, ...items], { canPickMany: true, title: 'Filter by Branch', placeHolder: 'Select branches, tags or revisions' });
    return picked?.map(p => p.label);
  }

  dispose() {
    allTabs.delete(this);
    this.model.dispose();
    this.conn?.dispose();
    this.disposables.forEach(d => d.dispose());
    this.onTitleEmitter.dispose();
  }
}

/** Parses absolute (YYYY-MM-DD) and simple relative ("3 days ago") dates. */
export function parseDate(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const rel = /^(\d+)\s*(minute|hour|day|week|month|year)s?\s*(ago)?$/i.exec(t);
  if (rel) {
    const unit: Record<string, number> = { minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
    return Math.floor(Date.now() / 1000) - +rel[1] * unit[rel[2].toLowerCase()];
  }
  const d = Date.parse(t);
  return isNaN(d) ? undefined : Math.floor(d / 1000);
}

/** Commit URL on the hosting service of the first remote (Git.Hosting.Open.In.Browser.Group). */
export function webCommitUrl(repo: Repository, hash: string): string | undefined {
  const remote = repo.remotes.find(r => r.name === 'origin') ?? repo.remotes[0];
  if (!remote) return undefined;
  const base = remoteWebUrl(remote.fetchUrl);
  if (!base) return undefined;
  if (base.includes('bitbucket.org')) return `${base}/commits/${hash}`;
  if (base.includes('gitlab')) return `${base}/-/commit/${hash}`;
  return `${base}/commit/${hash}`;
}

export function remoteWebUrl(url: string): string | undefined {
  let m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  return undefined;
}
