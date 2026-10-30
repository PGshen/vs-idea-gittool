import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
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

const SETTINGS_KEY = 'ideagittool.log.ui';

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
    if (this.state.mode === 'history') return translate('History: {0}', filtersTitle(this.state.filters));
    if (this.state.mode === 'compare' && this.state.compare) return translate('{0} vs {1}', this.state.compare.ref, this.state.compare.with);
    const t = filtersTitle(this.state.filters);
    return t ? translate('Log: {0}', t) : translate('Log');
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
      find: (p: string | { q: string; label?: string }) => (typeof p === 'string' ? this.find(p) : this.find(p.q, p.label)),
      commitAction: (p: { id: string; hashes: string[]; arg?: string }) => this.commitAction(p.id, p.hashes, p.arg),
      changeAction: (p: { id: string; changes: Change[]; left: string; right: string; hashes: string[] }) => this.changeAction(p.id, p.changes, p.left, p.right, p.hashes),
      branchAction: (p: { id: string; name: string; type: string; root?: string }) => this.branchAction(p.id, p.name, p.type, p.root),
      command: (p: { id: string; args?: unknown }) => vscode.commands.executeCommand(p.id, p.args),
      pickPaths: () => this.pickPaths(),
      pickDate: (p: { which: 'since' | 'until' }) => this.pickDate(p.which),
      pickBranches: () => this.pickBranches(),
      copy: (text: string) => vscode.env.clipboard.writeText(text),
      newTab: (p?: { filters?: LogFilters }) => vscode.commands.executeCommand('ideagittool.log.newTab', { root: this.repo.root, filters: p?.filters, multi: this.state.multi }),
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

  /** Finds a commit or reference. label names it in the messages (e.g. the branch whose head hash is q). */
  private async find(q: string, label?: string): Promise<{ index: number; hash: string } | undefined> {
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
      void vscode.window.showWarningMessage(translate('{0} not found', q));
      return undefined;
    }
    const i = await this.findIndex(hash);
    if (i < 0) {
      const viewAndReset = translate('View and reset filters');
      const viewInNewTab = translate('View in new tab');
      const name = label ?? (/^[0-9a-f]{40}$/i.test(q) ? q.slice(0, 8) : q);
      const pick = await vscode.window.showWarningMessage(translate("Commit or reference '{0}' doesn't match the filters", name), viewAndReset, viewInNewTab);
      if (pick === viewAndReset) {
        await this.setFilters({ ...EMPTY_FILTERS }, this.state.options);
        this.conn?.post('filtersReset', { filters: this.state.filters });
        const j = await this.model.find(hash);
        return j >= 0 ? { index: j, hash } : undefined;
      }
      if (pick === viewInNewTab) await vscode.commands.executeCommand('ideagittool.log.selectCommit', { root: this.repo.root, hash, newTab: true });
      return undefined;
    }
    return { index: i, hash: this.model.rows[i].commit.hash };
  }

  // ------------------------------------------------------------------ highlighters and columns

  /** The last single-file diff opened from this log, followed by single clicks in the changes tree. */
  private diffTab?: { original: vscode.Uri; modified: vscode.Uri };

  /** The editor tab showing that diff, when it is open and the active tab of its group. */
  private shownDiffTab(d: { original: vscode.Uri; modified: vscode.Uri }): vscode.Tab | undefined {
    return vscode.window.tabGroups.all
      .map(g => g.activeTab)
      .find(t => t?.input instanceof vscode.TabInputTextDiff && t.input.original.toString() === d.original.toString() && t.input.modified.toString() === d.modified.toString());
  }

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
        return run('ideagittool.createPatch', { root, hashes: ordered });
      case 'cherryPick':
        // Oldest first.
        return run('ideagittool.cherryPick', { root, hashes: [...ordered].reverse() });
      case 'checkoutRevision':
        return run('ideagittool.checkoutRevision', { root, hash: ordered[0] });
      case 'checkoutBranch':
        return run('ideagittool.branch.checkout', { root, name: arg, type: arg?.includes('/') && repo.refs.some(r => r.type === 'remote' && r.name === arg) ? 'remote' : 'local' });
      case 'showRepositoryAtRevision':
        return run('ideagittool.showRepositoryAtRevision', { root, hash: ordered[0] });
      case 'compareVersions': {
        const [a, b] = [ordered[ordered.length - 1], ordered[0]];
        return this.compareCommits(repo, a, b);
      }
      case 'compareWithLocal':
        return this.compareWithLocal(repo, ordered[0]);
      case 'reset':
        return run('ideagittool.resetHead', { root, hash: ordered[0] });
      case 'revert':
        return run('ideagittool.revertCommits', { root, hashes: ordered });
      case 'undo':
        return run('ideagittool.undoCommit', { root, hash: ordered[ordered.length - 1] });
      case 'reword':
        return run('ideagittool.rewordCommit', { root, hash: ordered[0] });
      case 'fixup':
        return run('ideagittool.fixupCommit', { root, hash: ordered[0] });
      case 'squashInto':
        return run('ideagittool.fixupCommit', { root, hash: ordered[0], squash: true });
      case 'drop':
        return run('ideagittool.dropCommits', { root, hashes: ordered });
      case 'squash':
        return run('ideagittool.squashCommits', { root, hashes: ordered });
      case 'interactiveRebase':
        return run('ideagittool.interactiveRebase', { root, hash: ordered[0] });
      case 'pushUpTo':
        return run('ideagittool.push', { root, upTo: ordered[0] });
      case 'addToRemote':
        return this.addToRemoteBranch(repo, [...ordered].reverse());
      case 'newBranch':
        return run('ideagittool.createBranch', { root, startPoint: ordered[0] });
      case 'newTag':
        return run('ideagittool.createTag', { root, hash: ordered[0] });
      case 'showDiff':
        return this.showCommitDiff(ordered);
      case 'showInLog':
        return run('ideagittool.log.selectCommit', { root, hash: ordered[0] });
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
      remotes.map(r => ({ label: r.name, description: r.name === repo.info.upstream ? translate('tracked') : undefined, ref: r })),
      { title: oldestFirst.length === 1 ? translate('Select Remote Branch for Commit') : translate('Select Remote Branch for Commits'), placeHolder: translate('Search remote branches'), matchOnDescription: true },
    );
    if (!picked) return;
    const remote = picked.ref.remote ?? picked.ref.name.split('/')[0];
    const branch = picked.ref.name.slice(remote.length + 1);
    const n = oldestFirst.length;
    try {
      const tip = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: n === 1 ? translate('Adding commit to {0}', branch) : translate('Adding commits to {0}', branch), cancellable: false },
        p => addCommitsToRemoteBranch(repo, oldestFirst, remote, branch, text => p.report({ message: text })),
      );
      if (!tip) {
        void vscode.window.showInformationMessage(translate('Nothing to add: All selected commits are already present on {0}', picked.ref.name));
        return;
      }
      const push = translate('Push');
      const ok = await vscode.window.showInformationMessage(
        n === 1 ? translate('Push {0} commit to {1} : {2}?', n, remote, branch) : translate('Push {0} commits to {1} : {2}?', n, remote, branch),
        { modal: true, detail: translate('{0} will become the new head of {1}.', tip.slice(0, 8), picked.ref.name) },
        push,
      );
      if (ok !== push) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: translate('Pushing to {0}/{1}…', remote, branch) }, () =>
        repo.exec(['push', '--porcelain', remote, `${tip}:refs/heads/${branch}`]),
      );
      await repo.exec(['fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { allowFailure: true });
      await repo.refresh();
      void vscode.window.showInformationMessage(n === 1 ? translate('Pushed {0} commit to {1}/{2}', n, remote, branch) : translate('Pushed {0} commits to {1}/{2}', n, remote, branch));
    } catch (e) {
      if (e instanceof MergeConflictError) void vscode.window.showErrorMessage(translate('Cherry-pick conflict: Failed to cherry-pick commits onto {0}:\n{1}', picked.ref.name, e.files.join('\n')));
      else void vscode.window.showErrorMessage(translate('Add to remote branch failed: {0}', e instanceof Error ? e.message : String(e)));
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
        const ok = await vscode.window.showWarningMessage(translate('Get revision {0} of {1}? Local changes will be overwritten.', hash.slice(0, 8), info.path), { modal: true }, translate('Get'));
        if (ok) await this.repo.exec(['checkout', hash, '--', info.path]);
        return;
      }
      case 'historyShowFile':
        return vscode.window.showTextDocument(toGitUri(root, info.path, change.status === 'D' ? `${hash}^` : hash), { preview: false });
      case 'historyCompareWithLocal':
        return openChangeDiff({ ...change, oldPath: info.path !== file ? info.path : undefined, path: file, status: 'M' }, hash, 'WORKTREE');
      case 'historyAnnotate':
        return vscode.commands.executeCommand('ideagittool.annotateRevision', { root, hash, path: info.path });
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
      void vscode.window.showInformationMessage(translate('No differences'));
      return;
    }
    await openMultiDiff(translate('{0} ↔ Local', hash.slice(0, 8)), changes, () => hash, () => 'WORKTREE');
  }

  private async changeAction(id: string, changes: Change[], left: string, right: string, hashes: string[]) {
    const repo = this.repoByRoot(changes[0]?.root);
    const root = repo.root;
    const leftRev = left === EMPTY_TREE ? REV_EMPTY : left;
    switch (id) {
      case 'diff':
        if (changes.length === 1) {
          this.diffTab = await openChangeDiff(changes[0], leftRev, right);
          return;
        }
        return openMultiDiff(`${right.slice(0, 8)}`, changes, () => leftRev, () => right);
      case 'followDiff': {
        // Single click: the diff this log opened follows the selected file while it is still shown, like IntelliJ's
        // diff preview tab. Without one, a click only selects.
        const tab = changes.length === 1 && this.diffTab ? this.shownDiffTab(this.diffTab) : undefined;
        if (tab) this.diffTab = await openChangeDiff(changes[0], leftRev, right, { viewColumn: tab.group.viewColumn, preserveFocus: true });
        return;
      }
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
          const res = await vscode.commands.executeCommand<{ remaining?: number } | undefined>('ideagittool.resolveConflicts', { root });
          const text =
            id === 'revertSelected'
              ? translate('Revert of selected changes finished with conflicts: {0}', r.stderr.trim())
              : translate('Cherry-pick of selected changes finished with conflicts: {0}', r.stderr.trim());
          if (res?.remaining !== 0) void vscode.window.showWarningMessage(text);
        } else void vscode.window.showInformationMessage(id === 'revertSelected' ? translate('Selected changes reverted') : translate('Selected changes applied'));
        return;
      }
      case 'dropSelected':
        return this.dropSelected(repo, hashes[0], changes);
      case 'extractSelected':
        return this.extractSelected(repo, hashes[0], changes);
      case 'createPatch':
        return vscode.commands.executeCommand('ideagittool.createPatch', { root, hashes, changes });
      case 'get': {
        const get = translate('Get');
        const question =
          changes.length === 1
            ? translate("Get '{0}' from revision {1}? Local changes will be overwritten.", changes[0].path, right.slice(0, 8))
            : translate('Get {0} files from revision {1}? Local changes will be overwritten.', changes.length, right.slice(0, 8));
        const answer = await vscode.window.showWarningMessage(question, { modal: true }, get);
        if (answer !== get) return;
        const existing = changes.filter(c => c.status !== 'D').map(c => c.path);
        const deleted = changes.filter(c => c.status === 'D').map(c => c.path);
        if (existing.length) await repo.exec(['checkout', right, '--', ...existing]);
        if (deleted.length) await repo.exec(['rm', '-f', '--ignore-unmatch', '--', ...deleted]);
        await repo.refresh();
        return;
      }
      case 'historyUpToHere':
        return vscode.commands.executeCommand('ideagittool.showFileHistory', { root, path: changes[0].path, revision: right });
      case 'copyPath':
        return vscode.env.clipboard.writeText(changes.map(c => c.path).join('\n'));
      case 'copyAbsolutePath':
        return vscode.env.clipboard.writeText(changes.map(c => path.join(c.root, c.path)).join('\n'));
    }
  }

  /** Drop Selected Changes (GitDropSelectedChangesAction). */
  private async dropSelected(repo: Repository, hash: string, changes: Change[]) {
    if (repo.info.operation !== 'none') {
      void vscode.window.showErrorMessage(translate('Could Not Drop Selected Changes: Another operation is in progress'));
      return;
    }
    await this.runEdit(
      repo,
      'drop selected changes',
      {
        progress: translate('Drop selected changes…'),
        success: translate('Selected changes dropped'),
        failure: translate('Could Not Drop Selected Changes'),
        cannotUndo: translate('Cannot undo drop selected changes: the repository has changed'),
        undoFailed: (msg: string) => translate('Undo drop selected changes failed: {0}', msg),
      },
      () => dropSelectedChanges(repo, hash, changes),
    );
  }

  /** Extract Selected Changes to Separate Commit… (GitExtractSelectedChangesAction). */
  private async extractSelected(repo: Repository, hash: string, changes: Change[]) {
    if (repo.info.operation !== 'none') {
      void vscode.window.showErrorMessage(translate('Could Not Extract Selected Changes: Another operation is in progress'));
      return;
    }
    const all = (await this.details([hash])).changes;
    if (changes.length >= all.length) {
      void vscode.window.showWarningMessage(translate('Unable to extract all changes from the commit'));
      return;
    }
    const d = (await loadDetails(repo, [hash]))[0];
    const message = await showDialog<{ message: string }>(
      'log.newCommitMessage',
      { label: translate('Changes extracted from commit {0} by {1}', hash.slice(0, 8), d?.authorName ?? ''), message: d?.body ?? '', okText: translate('OK') },
      { title: translate('New Commit Message'), validate: (v: { message: string }) => (v.message.trim() ? true : translate('Specify commit message')) },
    );
    if (!message) return;
    await this.runEdit(
      repo,
      'extract selected changes',
      {
        progress: translate('Extract selected changes…'),
        success: translate('Changes extracted'),
        failure: translate('Could Not Extract Selected Changes'),
        cannotUndo: translate('Cannot undo extract selected changes: the repository has changed'),
        undoFailed: (msg: string) => translate('Undo extract selected changes failed: {0}', msg),
      },
      () => extractSelectedChanges(repo, hash, changes, message.message),
    );
  }

  /** `operation` goes to the reflog (not translated); `text` holds the messages shown to the user. */
  private async runEdit(
    repo: Repository,
    operation: string,
    text: { progress: string; success: string; failure: string; cannotUndo: string; undoFailed: (msg: string) => string },
    fn: () => Promise<EditResult>,
  ) {
    let result: EditResult;
    try {
      result = await repo.batch(async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: text.progress }, fn));
    } catch (e) {
      const msg = e instanceof InMemoryError || e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(translate('{0}: {1}', text.failure, msg));
      return;
    }
    await this.refresh();
    void this.select(result.focus);
    const undo = translate('Undo');
    const picked = await vscode.window.showInformationMessage(text.success, undo);
    if (picked !== undo) return;
    try {
      await repo.refresh();
      if (repo.info.headHash !== result.newHead) {
        void vscode.window.showErrorMessage(text.cannotUndo);
        return;
      }
      await repo.batch(() => undoEdit(repo, result, operation));
    } catch (e) {
      void vscode.window.showErrorMessage(text.undoFailed(e instanceof Error ? e.message : String(e)));
    }
  }

  private branchAction(id: string, name: string, type: string, root?: string) {
    if (id === 'filter') return; // handled in the webview
    return vscode.commands.executeCommand(`ideagittool.${type === 'tag' ? 'tag' : 'branch'}.${id}`, { root: root ?? this.repo.root, name, type });
  }

  private async pickPaths(): Promise<string[] | undefined> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(this.repo.root), openLabel: translate('Select') });
    if (!uris) return undefined;
    // In a multi-root log paths are absolute; each repository gets the paths inside it.
    if (this.multi) return uris.map(u => u.fsPath);
    return uris.map(u => this.repo.relPath(u.fsPath)).filter(p => !p.startsWith('..'));
  }

  private async pickDate(which: 'since' | 'until'): Promise<number | undefined> {
    const v = await vscode.window.showInputBox({
      title: translate('Select Period'),
      prompt: which === 'since' ? translate('Show commits made since (YYYY-MM-DD or "2 weeks ago")') : translate('Show commits made until (YYYY-MM-DD)'),
      placeHolder: new Date().toISOString().slice(0, 10),
      validateInput: s => (parseDate(s) === undefined ? translate('Enter a date like 2026-06-01 or a relative period like "3 days ago"') : undefined),
    });
    return v === undefined ? undefined : parseDate(v);
  }

  private async pickBranches(): Promise<string[] | undefined> {
    const seen = new Set<string>();
    const items = this.allRefs()
      .filter(r => !seen.has(r.name) && seen.add(r.name))
      .map(r => ({ label: r.name, description: r.type === 'tag' ? translate('tag') : r.type === 'remote' ? translate('remote') : translate('local') }));
    const picked = await vscode.window.showQuickPick([{ label: 'HEAD', description: '' }, ...items], { canPickMany: true, title: translate('Filter by Branch'), placeHolder: translate('Select branches, tags or revisions') });
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
