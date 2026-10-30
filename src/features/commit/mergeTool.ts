import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { popOutIfConfigured } from '../../host/popOut';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { getExtensionUri, WebviewConnection } from '../../host/webviewHost';
import { CompareMode, DEFAULT_MERGE_SETTINGS, MergeFinish, MergeInit, MergeProgress, MergeSettings, TitleParts } from '../../shared/mergeProtocol';
import { Change } from '../../shared/types';

const SETTINGS_KEY = 'ideagittool.merge.settings';

/** Placeholder value for boldTitle: `boldTitle(translate('Changes from {0}', BOLD), branch)`. */
export const BOLD = '\u0001';

/** Title parts from a translated text with BOLD in place of the value shown in bold. */
export function boldTitle(text: string, value: string): TitleParts {
  const i = text.indexOf(BOLD);
  if (i < 0) return [{ text }];
  const parts: TitleParts = [];
  if (i > 0) parts.push({ text: text.slice(0, i) });
  parts.push({ text: value, bold: true });
  if (i + BOLD.length < text.length) parts.push({ text: text.slice(i + BOLD.length) });
  return parts;
}

export interface MergeRevisions {
  base: string;
  left: string;
  right: string;
}

/**
 * IntelliJ's merge window (TextMergeViewer / MergeThreesideViewer): Yours on the left, the editable
 * Result in the middle and Theirs on the right, rendered by the `merge` webview bundle.
 */
export class MergeTool {
  constructor(private readonly ctx: Ctx) {}

  settings(): MergeSettings {
    return { ...DEFAULT_MERGE_SETTINGS, ...this.ctx.extension.globalState.get<Partial<MergeSettings>>(SETTINGS_KEY, {}) };
  }

  /** "Diff & Merge > Context lines": 1, 2, 4, 8 or -1 (do not collapse). */
  contextLines(): number {
    const v = vscode.workspace.getConfiguration('ideagittool').get<number>('merge.contextLines', 4);
    return [1, 2, 4, 8, -1].includes(v) ? v : 4;
  }

  /**
   * Shows the merge window for one file and resolves with the result when it is closed. Closing the tab
   * is "Cancel" ("Save and Close" in the iterative flow, with the last progress of the window).
   */
  open(
    repo: Repository,
    c: Change,
    revisions: MergeRevisions,
    opts: { iterative: boolean; progress?: MergeProgress; titles?: { left: TitleParts; right: TitleParts } },
  ): Promise<MergeFinish> {
    const titles = opts.titles ? { left: opts.titles.left, result: [{ text: translate('Result') }], right: opts.titles.right } : this.titles(repo);
    const plain = (t: TitleParts) => t.map(p => p.text).join('');
    const init: MergeInit = {
      path: c.path,
      fileName: path.posix.basename(c.path),
      titles,
      base: revisions.base,
      left: revisions.left,
      right: revisions.right,
      settings: this.settings(),
      contextLines: this.contextLines(),
      iterative: opts.iterative,
      progress: opts.progress,
    };
    return new Promise<MergeFinish>(resolve => {
      const panel = vscode.window.createWebviewPanel('ideagittool.merge', translate('Merge Revisions for {0}', c.path), vscode.ViewColumn.Active, {
        retainContextWhenHidden: true,
      });
      panel.iconPath = {
        light: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'merge.svg'),
        dark: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'merge_dark.svg'),
      };
      void popOutIfConfigured(panel);
      let outcome: MergeFinish | undefined;
      let last: MergeFinish | undefined = opts.progress ? { result: 'CANCEL', ...opts.progress } : undefined;
      const conn = new WebviewConnection(panel.webview, 'merge', () => init, panel.title);
      const temp: string[] = [];
      const write = (name: string, text: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-merge-'));
        const f = path.join(dir, `${name} - ${init.fileName}`);
        fs.writeFileSync(f, text);
        temp.push(dir);
        return vscode.Uri.file(f);
      };
      conn.handleAll({
        finish: (p: MergeFinish) => {
          outcome = p;
          panel.dispose();
        },
        progress: (p: MergeFinish) => {
          last = p;
        },
        ask: async (p: { title: string; message: string; yes: string; no: string; icon?: string }) => {
          const show = p.icon === 'question' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
          const r = await show(p.title, { modal: true, detail: p.message }, p.yes, p.no);
          return r === p.yes;
        },
        compare: async (p: { mode: CompareMode; result: string }) => {
          const uri = {
            base: () => write('Base', init.base),
            left: () => write(plain(titles.left), init.left),
            right: () => write(plain(titles.right), init.right),
            result: () => write('Result', p.result),
          };
          const [a, b] = p.mode.split('-') as (keyof typeof uri)[];
          const name = (k: string) => (k === 'left' ? translate('Left') : k === 'right' ? translate('Right') : k === 'base' ? translate('Base') : translate('Result'));
          await vscode.commands.executeCommand('vscode.diff', uri[a](), uri[b](), `${init.fileName} (${name(a)} ↔ ${name(b)})`, {
            viewColumn: vscode.ViewColumn.Beside,
          });
        },
        // CompareClipboardWithSelection
        compareClipboard: async (p: { text: string; fileName: string }) => {
          const clip = await vscode.env.clipboard.readText();
          await vscode.commands.executeCommand('vscode.diff', write('Clipboard', clip), write('Selection', p.text), translate('Clipboard ↔ {0}', p.fileName), {
            viewColumn: vscode.ViewColumn.Beside,
          });
        },
        saveSettings: (s: MergeSettings) => this.ctx.extension.globalState.update(SETTINGS_KEY, s),
      });
      panel.onDidDispose(() => {
        conn.dispose();
        for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
        resolve(outcome ?? (opts.iterative && last ? { ...last, result: 'CANCEL' } : { result: 'CANCEL', lines: [], states: [], contentModified: false }));
      });
    });
  }

  /** Column titles of GitDefaultMergeDialogCustomizer. */
  titles(repo: Repository): MergeInit['titles'] {
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(repo.gitDir, f), 'utf8').trim();
      } catch {
        return undefined;
      }
    };
    const short = (h: string | undefined) => (h ? h.slice(0, 8) : '');
    const branchAt = (hash: string | undefined) => {
      if (!hash) return undefined;
      const r = repo.refs.find(x => (x.type === 'local' || x.type === 'remote') && x.hash === hash);
      return r?.name;
    };
    const result: TitleParts = [{ text: translate('Result') }];
    const current = repo.info.branch ?? short(repo.info.headHash);
    switch (repo.info.operation) {
      case 'merge': {
        const mergeHead = read('MERGE_HEAD')?.split('\n')[0];
        const other = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG') ?? '')?.[1] ?? branchAt(mergeHead) ?? short(mergeHead);
        return {
          left: boldTitle(translate('Changes from {0}', BOLD), current),
          result,
          right: boldTitle(translate('Changes from {0}', BOLD), other),
        };
      }
      case 'rebase': {
        const rebaseHead = read('REBASE_HEAD');
        const branch = repo.info.rebaseHeadName ?? current;
        const onto = read('rebase-merge/onto') ?? read('rebase-apply/onto');
        const ontoBranch = branchAt(onto);
        return {
          left: boldTitle(translate('Rebasing {0} from {1}', short(rebaseHead), BOLD), branch),
          result,
          right: ontoBranch ? boldTitle(translate('Already rebased commits and commits from {0}', BOLD), ontoBranch) : [{ text: translate('Already rebased commits') }],
        };
      }
      case 'cherry-pick': {
        const h = read('CHERRY_PICK_HEAD');
        return { left: [{ text: translate('Local Changes') }], result, right: boldTitle(translate('Changes from cherry-pick {0}', BOLD), short(h)) };
      }
      case 'revert': {
        const h = read('REVERT_HEAD');
        return { left: [{ text: translate('Local Changes') }], result, right: boldTitle(translate('Changes from revert {0}', BOLD), short(h)) };
      }
      default:
        return {
          left: repo.info.branch ? boldTitle(translate('Your version, branch {0}', BOLD), repo.info.branch) : [{ text: translate('Your version') }],
          result,
          right: [{ text: translate('Changes from diverging branches') }],
        };
    }
  }
}

export function isBinary(b: Buffer) {
  return b.subarray(0, 8000).includes(0);
}
