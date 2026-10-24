import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { changeKey } from '../../shared/commitProtocol';
import { ConflictsController } from './conflicts';

/** VS Code's built-in conflict UI that competes with the Conflicts dialog (ids from the merge-conflict and git extensions). */
export const BUILT_IN_CONFLICT_SETTINGS: readonly { section: string; key: string }[] = [
  { section: 'merge-conflict', key: 'codeLens.enabled' },
  { section: 'merge-conflict', key: 'decorators.enabled' },
  { section: 'git', key: 'mergeEditor' },
];

export type HandleConflicts = 'ask' | 'always' | 'never';

/** The parts of VS Code the consent flow uses, so that it can be tested without VS Code. */
export interface ConflictUiHost {
  inspect(section: string, key: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined;
  update(section: string, key: string, value: unknown, target: 'global' | 'workspace'): Thenable<void>;
  handleConflicts(): HandleConflicts;
  setHandleConflicts(value: HandleConflicts): Thenable<void>;
  /** Per-workspace memory: the question was asked in this workspace. */
  asked(): boolean;
  setAsked(): Thenable<void>;
  /** Values the settings had before IdeaGitTool changed them, to restore them. */
  saved(): Record<string, { global?: unknown; workspace?: unknown }>;
  setSaved(v: Record<string, { global?: unknown; workspace?: unknown }>): Thenable<void>;
  askUser(): Thenable<'yes' | 'no' | undefined>;
}

/**
 * Turns VS Code's conflict CodeLens, decorations and automatic merge editor off, only with the user's consent:
 * the answer to the question asked once per workspace ("ask"), or `ideagittool.merge.handleConflicts` set to "always".
 */
export class ConflictUiSettings {
  /** apply / restore run one after the other: each reads the values the previous one wrote. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: ConflictUiHost) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => undefined);
    return r;
  }

  /** Called when a repository has conflicts. Returns true when the built-in UI was turned off. */
  async onConflicts(): Promise<boolean> {
    const mode = this.host.handleConflicts();
    if (mode === 'never') return false;
    if (mode === 'always') return this.apply();
    if (this.host.asked()) return false;
    await this.host.setAsked();
    const answer = await this.host.askUser();
    if (answer === 'yes') {
      const r = await this.apply();
      await this.host.setHandleConflicts('always');
      return r;
    }
    if (answer === 'no') await this.host.setHandleConflicts('never');
    return false;
  }

  /** Writes `false` where the built-in UI is on; remembers the previous values. */
  apply(): Promise<boolean> {
    return this.serial(() => this.doApply());
  }

  private async doApply(): Promise<boolean> {
    const saved = { ...this.host.saved() };
    let changed = false;
    for (const { section, key } of BUILT_IN_CONFLICT_SETTINGS) {
      const id = `${section}.${key}`;
      const i = this.host.inspect(section, key);
      const entry = saved[id] ?? {};
      // A workspace value would win over the user setting.
      if (i?.workspaceValue !== undefined && i.workspaceValue !== false) {
        if (!('workspace' in entry)) entry.workspace = i.workspaceValue;
        await this.host.update(section, key, false, 'workspace');
        changed = true;
      }
      if (i?.globalValue !== false && !(section === 'git' && i?.globalValue === undefined)) {
        // git.mergeEditor is off by default: only an explicit `true` is changed.
        if (!('global' in entry)) entry.global = i?.globalValue;
        await this.host.update(section, key, false, 'global');
        changed = true;
      }
      if ('global' in entry || 'workspace' in entry) saved[id] = entry;
    }
    await this.host.setSaved(saved);
    return changed;
  }

  /** "Restore VS Code's Built-in Merge Conflict UI": the values before IdeaGitTool changed them. */
  restore(): Promise<void> {
    return this.serial(() => this.doRestore());
  }

  private async doRestore(): Promise<void> {
    const saved = this.host.saved();
    for (const { section, key } of BUILT_IN_CONFLICT_SETTINGS) {
      const entry = saved[`${section}.${key}`];
      if (!entry) continue;
      if ('global' in entry) await this.host.update(section, key, entry.global, 'global');
      if ('workspace' in entry) await this.host.update(section, key, entry.workspace, 'workspace');
    }
    await this.host.setSaved({});
    await this.host.setHandleConflicts('never');
  }
}

const SAVED_KEY = 'ideagittool.merge.builtInConflictUi';
const ASKED_KEY = 'ideagittool.merge.handleConflictsAsked';

function vscodeHost(ctx: Ctx): ConflictUiHost {
  const target = (t: 'global' | 'workspace') => (t === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  const cfg = () => vscode.workspace.getConfiguration('ideagittool');
  return {
    inspect: (section, key) => vscode.workspace.getConfiguration(section).inspect(key),
    update: (section, key, value, t) => vscode.workspace.getConfiguration(section).update(key, value, target(t)),
    handleConflicts: () => {
      const v = cfg().get<string>('merge.handleConflicts', 'ask');
      return v === 'always' || v === 'never' ? v : 'ask';
    },
    setHandleConflicts: v => cfg().update('merge.handleConflicts', v, vscode.ConfigurationTarget.Global),
    asked: () => ctx.extension.workspaceState.get<boolean>(ASKED_KEY, false),
    setAsked: () => ctx.extension.workspaceState.update(ASKED_KEY, true),
    saved: () => ctx.extension.globalState.get(SAVED_KEY, {}),
    setSaved: v => ctx.extension.globalState.update(SAVED_KEY, v),
    askUser: async () => {
      const yes = vscode.l10n.t('Use IdeaGitTool');
      const no = vscode.l10n.t("Keep VS Code's");
      const a = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Resolve merge conflicts with IdeaGitTool? IdeaGitTool opens its Conflicts dialog when an operation stops with conflicts. VS Code's conflict CodeLens and decorations (merge-conflict.codeLens.enabled, merge-conflict.decorators.enabled) and its merge editor (git.mergeEditor) will be turned off. You can restore them with \"Restore VS Code's Built-in Merge Conflict UI\".",
        ),
        yes,
        no,
      );
      return a === yes ? 'yes' : a === no ? 'no' : undefined;
    },
  };
}

/**
 * Conflicted files in the editor: "Resolve Conflicts… (IdeaGitTool)" in the editor title and as a CodeLens at the
 * first conflict marker, for files git reports unmerged; and the one-time question about VS Code's conflict UI.
 */
export function registerConflictEditor(ctx: Ctx, conflicts: ConflictsController) {
  const changed = new vscode.EventEmitter<void>();
  let files = new Set<string>();
  const settings = new ConflictUiSettings(vscodeHost(ctx));
  let asking = false;

  const update = () => {
    const next = new Set(ctx.repos.repositories.flatMap(r => r.status.conflicts.map(c => vscode.Uri.file(path.join(c.root, c.path)).toString())));
    const same = next.size === files.size && [...next].every(f => files.has(f));
    if (same) return;
    files = next;
    void vscode.commands.executeCommand('setContext', 'ideagittool.conflictedFiles', [...files]);
    changed.fire();
    if (files.size && !asking) {
      asking = true;
      void settings.onConflicts().finally(() => (asking = false));
    }
  };

  ctx.extension.subscriptions.push(
    changed,
    ctx.repos.onDidChangeRepository(update),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: changed.event,
        provideCodeLenses(doc) {
          if (!files.has(doc.uri.toString())) return [];
          for (let i = 0; i < doc.lineCount; i++) {
            if (/^<{7}( |$)/.test(doc.lineAt(i).text)) {
              return [new vscode.CodeLens(new vscode.Range(i, 0, i, 0), { title: vscode.l10n.t('Resolve Conflicts… (IdeaGitTool)'), command: 'ideagittool.resolveConflictsInFile', arguments: [doc.uri] })];
            }
          }
          return [];
        },
      },
    ),
  );

  ctx.command('ideagittool.resolveConflictsInFile', async (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const repo = ctx.repos.getForFile(target.fsPath);
    const c = repo?.status.conflicts.find(x => path.join(x.root, x.path) === target.fsPath);
    if (!repo || !c) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No conflicts to resolve'));
      return;
    }
    // The Conflicts dialog for this file, with its merge window open.
    return conflicts.show(repo.root, [changeKey(c)], undefined, { openMerge: true });
  });
  ctx.command('ideagittool.merge.useIdeaGitToolForConflicts', async () => {
    await settings.apply();
    await vscode.workspace.getConfiguration('ideagittool').update('merge.handleConflicts', 'always', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(vscode.l10n.t("IdeaGitTool resolves merge conflicts: VS Code's conflict CodeLens, decorations and merge editor are turned off"));
  });
  ctx.command('ideagittool.merge.restoreVsCodeConflictUi', async () => {
    await settings.restore();
    void vscode.window.showInformationMessage(vscode.l10n.t("VS Code's built-in merge conflict UI was restored"));
  });
  ctx.extension.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      // Choosing "always" in the settings is consent too.
      if (e.affectsConfiguration('ideagittool.merge.handleConflicts') && vscodeHost(ctx).handleConflicts() === 'always') void settings.apply();
    }),
  );
  void ctx.repos.ready().then(update);
}
