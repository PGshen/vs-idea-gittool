import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { getExtensionUri } from '../../host/webviewHost';
import { registerAnnotate } from './annotate';
import { registerCompare } from './compare';
import { EMPTY_FILTERS, LogFilters, LogOptions } from './filters';
import { LogTab, LogTabState } from './logTab';
import { fileFromArg } from './util';

const MAIN_KEY = 'rebased.log.main';
const DEFAULT_OPTIONS: LogOptions = { sort: 'date', firstParent: false };

interface OpenTab {
  tab: LogTab;
  panel?: vscode.WebviewPanel;
  view?: vscode.WebviewView;
  main: boolean;
}

/**
 * Log tabs: the main log (editor tab "Log" or the panel view, per `rebased.log.showInEditor`)
 * plus extra tabs (new tab, branch filtered tabs, file history, branch comparison).
 */
class LogTabs {
  private readonly tabs: OpenTab[] = [];
  private logView: vscode.WebviewView | undefined;

  constructor(private readonly ctx: Ctx) {}

  private get showInEditor() {
    return vscode.workspace.getConfiguration('rebased.log').get<boolean>('showInEditor', true);
  }

  mainState(repo: Repository): LogTabState {
    const saved = this.ctx.extension.workspaceState.get<{ filters: LogFilters; options: LogOptions }>(`${MAIN_KEY}:${repo.root}`);
    return { root: repo.root, mode: 'log', filters: { ...EMPTY_FILTERS, ...saved?.filters, follow: undefined, lines: undefined }, options: { ...DEFAULT_OPTIONS, ...saved?.options } };
  }

  main(): OpenTab | undefined {
    return this.tabs.find(t => t.main);
  }

  /** Opens or reveals the main log. */
  async showMain(repo?: Repository, preserveFocus = false): Promise<OpenTab | undefined> {
    repo ??= await this.ctx.repos.pick();
    if (!repo) return undefined;
    const existing = this.main();
    if (existing) {
      if (existing.tab.root !== repo.root) {
        existing.tab.dispose();
        this.tabs.splice(this.tabs.indexOf(existing), 1);
      } else {
        existing.panel?.reveal(undefined, preserveFocus);
        if (existing.view) existing.view.show(preserveFocus);
        return existing;
      }
    }
    if (this.showInEditor) return this.openPanel(repo, this.mainState(repo), true, undefined, preserveFocus);
    await vscode.commands.executeCommand('rebased.logView.focus');
    return this.main();
  }

  async openPanel(repo: Repository, state: LogTabState, main: boolean, existingPanel?: vscode.WebviewPanel, preserveFocus = false): Promise<OpenTab> {
    const tab = new LogTab(this.ctx, repo, state, main ? `${MAIN_KEY}:${repo.root}` : undefined);
    await tab.start();
    const panel =
      existingPanel ??
      vscode.window.createWebviewPanel('rebased.log', tab.title, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, { retainContextWhenHidden: true, enableFindWidget: false });
    panel.title = tab.title;
    const icon = state.mode === 'history' ? 'general/history' : 'toolwindows/changes';
    panel.iconPath = {
      light: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', `${icon}.svg`),
      dark: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', `${icon}_dark.svg`),
    };
    tab.attach(panel.webview);
    tab.onTitle(t => (panel.title = t));
    const entry: OpenTab = { tab, panel, main };
    this.tabs.push(entry);
    panel.onDidDispose(() => {
      tab.dispose();
      const i = this.tabs.indexOf(entry);
      if (i >= 0) this.tabs.splice(i, 1);
    });
    return entry;
  }

  /** WebviewView in the bottom panel (when the log is not shown in the editor). */
  async resolveView(view: vscode.WebviewView) {
    this.logView = view;
    await this.ctx.repos.ready();
    const repo = this.ctx.repos.repositories[0];
    if (!repo) {
      view.webview.html = `<body style="padding:16px;font-family:sans-serif;opacity:.7">No Git repository found in the workspace.</body>`;
      return;
    }
    const tab = new LogTab(this.ctx, repo, this.mainState(repo), `${MAIN_KEY}:${repo.root}`);
    await tab.start();
    tab.attach(view.webview);
    tab.onTitle(t => (view.description = t.replace(/^Log:?\s*/, '')));
    const entry: OpenTab = { tab, view, main: true };
    this.tabs.push(entry);
    view.onDidDispose(() => {
      tab.dispose();
      const i = this.tabs.indexOf(entry);
      if (i >= 0) this.tabs.splice(i, 1);
      this.logView = undefined;
    });
  }

  async newTab(repo: Repository, state: Partial<LogTabState>) {
    return this.openPanel(repo, { root: repo.root, mode: 'log', filters: { ...EMPTY_FILTERS }, options: { ...DEFAULT_OPTIONS }, ...state }, false);
  }

  async selectCommit(repo: Repository, hash: string, newTab = false) {
    if (newTab) {
      const t = await this.newTab(repo, { select: hash });
      void t.tab.select(hash);
      return;
    }
    const main = await this.showMain(repo);
    if (main && !(await main.tab.select(hash))) {
      void vscode.window.showWarningMessage(`Commit ${hash.slice(0, 8)} not found in the log`);
    }
  }
}

async function repoFromArg(ctx: Ctx, arg: any): Promise<Repository | undefined> {
  await ctx.repos.ready();
  if (arg?.root) return ctx.repos.get(arg.root);
  if (arg instanceof vscode.Uri && arg.scheme === 'file') return ctx.repos.getForFile(arg.fsPath);
  return ctx.repos.pick();
}

export function register(ctx: Ctx) {
  const tabs = new LogTabs(ctx);
  const ext = ctx.extension;

  ext.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('rebased.log', {
      async deserializeWebviewPanel(panel) {
        await ctx.repos.ready();
        const repo = ctx.repos.repositories[0];
        if (!repo || tabs.main()) {
          panel.dispose();
          return;
        }
        await tabs.openPanel(repo, tabs.mainState(repo), true, panel);
      },
    }),
    vscode.window.registerWebviewViewProvider('rebased.logView', { resolveWebviewView: v => tabs.resolveView(v) }, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  ctx.command('rebased.showLog', async (arg?: { root?: string; branch?: string; path?: string }) => {
    const repo = await repoFromArg(ctx, arg);
    if (!repo) return;
    if (arg?.branch || arg?.path) {
      await tabs.newTab(repo, { filters: { ...EMPTY_FILTERS, branches: arg.branch ? [arg.branch] : [], paths: arg.path ? [arg.path] : [] } });
    } else await tabs.showMain(repo);
  });

  ctx.command('rebased.log.newTab', async (arg?: { root?: string; filters?: LogFilters }) => {
    const repo = await repoFromArg(ctx, arg);
    if (repo) await tabs.newTab(repo, { filters: { ...EMPTY_FILTERS, ...arg?.filters } });
  });

  ctx.command('rebased.log.selectCommit', async (arg: { root: string; hash: string; newTab?: boolean }) => {
    const repo = await repoFromArg(ctx, arg);
    if (repo) await tabs.selectCommit(repo, arg.hash, arg.newTab);
  });

  ctx.command('rebased.showFileHistory', async (arg?: any) => {
    const f = await fileFromArg(ctx, arg);
    if (!f) return;
    const isDir = await isDirectory(f.repo, f.path);
    await tabs.newTab(f.repo, {
      mode: 'history',
      filters: { ...EMPTY_FILTERS, paths: [f.path], follow: !isDir, branches: arg?.revision ? [arg.revision] : ['HEAD'] },
    });
  });

  ctx.command('rebased.showHistoryForSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    const f = await fileFromArg(ctx, undefined);
    if (!f || !editor) return;
    const sel = editor.selection;
    const start = sel.start.line + 1;
    const end = Math.max(start, sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1);
    await tabs.newTab(f.repo, { mode: 'history', filters: { ...EMPTY_FILTERS, branches: ['HEAD'], lines: { path: f.path, start, end } } });
  });

  registerAnnotate(ctx);
  registerCompare(ctx, (repo, state) => tabs.newTab(repo, state));

  // Open the log on startup, like Rebased opens it in the editor when a project is opened.
  void (async () => {
    await ctx.repos.ready();
    const cfg = vscode.workspace.getConfiguration('rebased.log');
    const repo = ctx.repos.repositories[0];
    if (!repo || !cfg.get<boolean>('openOnStartup', true) || !cfg.get<boolean>('showInEditor', true)) return;
    // A restored panel (serializer) counts as opened.
    await new Promise(r => setTimeout(r, 1500));
    if (!tabs.main()) await tabs.showMain(repo, true);
  })();

  vscode.workspace.onDidChangeConfiguration(
    e => {
      if (e.affectsConfiguration('rebased.log.showInEditor')) {
        void vscode.commands.executeCommand('setContext', 'rebased.logInPanel', !vscode.workspace.getConfiguration('rebased.log').get<boolean>('showInEditor', true));
      }
    },
    null,
    ext.subscriptions,
  );
  void vscode.commands.executeCommand('setContext', 'rebased.logInPanel', !vscode.workspace.getConfiguration('rebased.log').get<boolean>('showInEditor', true));
}

async function isDirectory(repo: Repository, rel: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(repo.root, rel)));
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}
