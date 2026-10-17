import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { confirmDialog } from '../../host/ui';
import { getExtensionUri, WebviewConnection } from '../../host/webviewHost';
import { CompareMode, DEFAULT_MERGE_SETTINGS, MergeInit, MergeSettings, TitleParts } from '../../shared/mergeProtocol';
import { Change } from '../../shared/types';
import { acceptSide, addFiles } from './gitOps';

const SETTINGS_KEY = 'rebased.merge.settings';

export type MergeOutcome = 'resolved' | 'cancelled';

/**
 * IntelliJ's merge window (TextMergeViewer / MergeThreesideViewer): Yours on the left, the editable
 * Result in the middle and Theirs on the right, rendered by the `merge` webview bundle.
 */
export class MergeTool {
  constructor(private readonly ctx: Ctx) {}

  /**
   * Opens the merge window for one conflicted file. `reversed` swaps git's stages (during a rebase
   * "yours" is git's "theirs"). Resolves when the window is closed.
   */
  async open(repo: Repository, c: Change, reversed: boolean): Promise<MergeOutcome> {
    const yoursStage = reversed ? ':3' : ':2';
    const theirsStage = reversed ? ':2' : ':3';
    const [base, yours, theirs] = await Promise.all([repo.show(':1', c.path), repo.show(yoursStage, c.path), repo.show(theirsStage, c.path)]);
    const xy = `${c.index}${c.workTree}`;
    const oursDeleted = xy === 'DU' || xy === 'DD';
    const theirsDeleted = xy === 'UD' || xy === 'DD';
    const yoursDeleted = reversed ? theirsDeleted : oursDeleted;
    const theirDeleted = reversed ? oursDeleted : theirsDeleted;
    const titles = this.titles(repo);
    const plain = (t: TitleParts) => t.map(p => p.text).join('');

    // Deleted on one side, or binary content: IntelliJ shows a simple choice instead of the text merge.
    if (yoursDeleted || theirDeleted || isBinary(base) || isBinary(yours) || isBinary(theirs)) {
      const message =
        yoursDeleted || theirDeleted
          ? `${c.path}\n\n${plain(titles.left)}: ${yoursDeleted ? 'deleted' : 'modified'}\n${plain(titles.right)}: ${theirDeleted ? 'deleted' : 'modified'}`
          : `${c.path} is a binary file. Choose the version to keep.`;
      const r = await confirmDialog({
        title: `Merge Revisions for ${c.path}`,
        message,
        icon: 'question',
        buttons: [
          { id: 'left', label: 'Accept Left' },
          { id: 'right', label: 'Accept Right' },
          { id: 'cancel', label: 'Cancel', primary: true },
        ],
      });
      if (!r || r.button === 'cancel') return 'cancelled';
      await this.accept(repo, c, r.button === 'left' ? 'left' : 'right', reversed);
      return 'resolved';
    }

    const init: MergeInit = {
      path: c.path,
      fileName: path.posix.basename(c.path),
      titles,
      base: base.toString('utf8'),
      left: yours.toString('utf8'),
      right: theirs.toString('utf8'),
      settings: { ...DEFAULT_MERGE_SETTINGS, ...this.ctx.extension.globalState.get<Partial<MergeSettings>>(SETTINGS_KEY, {}) },
    };

    return new Promise<MergeOutcome>(resolve => {
      const panel = vscode.window.createWebviewPanel('rebased.merge', `Merge Revisions for ${c.path}`, vscode.ViewColumn.Active, {
        retainContextWhenHidden: true,
      });
      panel.iconPath = {
        light: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'merge.svg'),
        dark: vscode.Uri.joinPath(getExtensionUri(), 'media', 'icons', 'vcs', 'merge_dark.svg'),
      };
      let outcome: MergeOutcome = 'cancelled';
      const conn = new WebviewConnection(panel.webview, 'merge', () => init, panel.title);
      const temp: string[] = [];
      conn.handleAll({
        apply: async (p: { text: string }) => {
          const file = repo.absPath(c.path);
          const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : init.left;
          const eol = /\r\n/.test(init.left || original) ? '\r\n' : '\n';
          let text = p.text;
          // The webview keeps a newline after every line; restore the file's own ending.
          const trailing = (init.left || init.right || init.base).endsWith('\n') || (!init.left && !init.right && !init.base);
          if (!trailing && text.endsWith('\n')) text = text.slice(0, -1);
          fs.writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol));
          await repo.batch(() => addFiles(repo, [c.path], true));
          outcome = 'resolved';
          panel.dispose();
        },
        accept: async (p: { side: 'left' | 'right' }) => {
          await this.accept(repo, c, p.side, reversed);
          outcome = 'resolved';
          panel.dispose();
        },
        close: () => panel.dispose(),
        ask: async (p: { title: string; message: string; yes: string; no: string }) => {
          const r = await vscode.window.showWarningMessage(p.title, { modal: true, detail: p.message }, p.yes, p.no);
          return r === p.yes;
        },
        compare: async (p: { mode: CompareMode; result: string }) => {
          const write = (name: string, text: string) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebased-merge-'));
            const f = path.join(dir, `${name} - ${init.fileName}`);
            fs.writeFileSync(f, text);
            temp.push(dir);
            return vscode.Uri.file(f);
          };
          const uri = {
            base: () => write('Base', init.base),
            left: () => write(plain(titles.left), init.left),
            right: () => write(plain(titles.right), init.right),
            result: () => write('Result', p.result),
          };
          const [a, b] = p.mode.split('-') as (keyof typeof uri)[];
          const name = (k: string) => (k === 'left' ? 'Left' : k === 'right' ? 'Right' : k === 'base' ? 'Base' : 'Middle');
          await vscode.commands.executeCommand('vscode.diff', uri[a](), uri[b](), `${init.fileName} (${name(a)} ↔ ${name(b)})`, {
            viewColumn: vscode.ViewColumn.Beside,
          });
        },
        saveSettings: (s: MergeSettings) => this.ctx.extension.globalState.update(SETTINGS_KEY, s),
      });
      panel.onDidDispose(() => {
        conn.dispose();
        for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
        resolve(outcome);
      });
    });
  }

  private async accept(repo: Repository, c: Change, side: 'left' | 'right', reversed: boolean) {
    const yours = side === 'left';
    const gitSide = yours !== reversed ? 'ours' : 'theirs';
    await repo.batch(() => acceptSide(repo, [c], gitSide));
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
    const result: TitleParts = [{ text: 'Result' }];
    const current = repo.info.branch ?? short(repo.info.headHash);
    switch (repo.info.operation) {
      case 'merge': {
        const mergeHead = read('MERGE_HEAD')?.split('\n')[0];
        const other = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG') ?? '')?.[1] ?? branchAt(mergeHead) ?? short(mergeHead);
        return {
          left: [{ text: 'Changes from ' }, { text: current, bold: true }],
          result,
          right: [{ text: 'Changes from ' }, { text: other, bold: true }],
        };
      }
      case 'rebase': {
        const rebaseHead = read('REBASE_HEAD');
        const branch = repo.info.rebaseHeadName ?? current;
        const onto = read('rebase-merge/onto') ?? read('rebase-apply/onto');
        const ontoBranch = branchAt(onto);
        return {
          left: [{ text: `Rebasing ${short(rebaseHead)} from ` }, { text: branch, bold: true }],
          result,
          right: ontoBranch ? [{ text: 'Already rebased commits and commits from ' }, { text: ontoBranch, bold: true }] : [{ text: 'Already rebased commits' }],
        };
      }
      case 'cherry-pick': {
        const h = read('CHERRY_PICK_HEAD');
        return { left: [{ text: 'Local Changes' }], result, right: [{ text: 'Changes from cherry-pick ' }, { text: short(h), bold: true }] };
      }
      case 'revert': {
        const h = read('REVERT_HEAD');
        return { left: [{ text: 'Local Changes' }], result, right: [{ text: 'Changes from revert ' }, { text: short(h), bold: true }] };
      }
      default:
        return {
          left: repo.info.branch ? [{ text: 'Your version, branch ' }, { text: repo.info.branch, bold: true }] : [{ text: 'Your version' }],
          result,
          right: [{ text: 'Changes from diverging branches' }],
        };
    }
  }
}

function isBinary(b: Buffer) {
  return b.subarray(0, 8000).includes(0);
}
