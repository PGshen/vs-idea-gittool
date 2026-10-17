import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { showDialog } from '../../host/dialog';
import { shortHash, toGitUri } from '../../host/gitContent';
import { notifySuccess } from '../../host/ui';
import { WebviewConnection } from '../../host/webviewHost';
import { changeKey } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { acceptSide, addFiles, conflictKind, resolveSimpleConflict } from './gitOps';

export interface ConflictRow {
  key: string;
  root: string;
  repoName: string;
  path: string;
  kind: string;
  yours: 'Modified' | 'Deleted';
  theirs: 'Modified' | 'Deleted';
}

/**
 * The Conflicts dialog (MultipleFileMergeDialog) and the 3-way merge in VS Code's merge editor.
 */
export class ConflictsController {
  /** Files open in the merge editor; staged when saved without conflict markers. */
  private readonly pending = new Map<string, { root: string; path: string }>();
  private dialog: WebviewConnection | undefined;

  constructor(private readonly ctx: Ctx) {
    ctx.extension.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => this.onSaved(doc)),
      ctx.repos.onDidChangeRepository(() => this.pushRows()),
    );
  }

  private conflicts(root?: string): Change[] {
    return this.ctx.repos.repositories.filter(r => !root || r.root === root).flatMap(r => r.status.conflicts);
  }

  /** Whether "yours" is git's "theirs": during a rebase git's "ours" is the branch being rebased onto. */
  private reversed(repo: Repository | undefined) {
    return repo?.info.operation === 'rebase';
  }

  rows(): ConflictRow[] {
    return this.conflicts().map(c => {
      const repo = this.ctx.repos.get(c.root);
      const xy = `${c.index}${c.workTree}`;
      const kind = conflictKind(xy);
      const oursDeleted = xy === 'DU' || xy === 'DD';
      const theirsDeleted = xy === 'UD' || xy === 'DD';
      const rev = this.reversed(repo);
      const yoursDeleted = rev ? theirsDeleted : oursDeleted;
      const theirDel = rev ? oursDeleted : theirsDeleted;
      return {
        key: changeKey(c),
        root: c.root,
        repoName: repo?.name ?? path.basename(c.root),
        path: c.path,
        kind,
        yours: yoursDeleted ? 'Deleted' : 'Modified',
        theirs: theirDel ? 'Deleted' : 'Modified',
      };
    });
  }

  /** "Merging branch feature into branch master" and the like. */
  description(): { text: string; yours: string; theirs: string } {
    const repo = this.ctx.repos.repositories.find(r => r.status.conflicts.length) ?? this.ctx.repos.repositories[0];
    if (!repo) return { text: '', yours: 'Yours', theirs: 'Theirs' };
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(repo.gitDir, f), 'utf8').trim();
      } catch {
        return undefined;
      }
    };
    const branch = repo.info.branch ?? repo.info.rebaseHeadName ?? shortHash(repo.info.headHash ?? '');
    switch (repo.info.operation) {
      case 'merge': {
        const other = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(read('MERGE_MSG') ?? '')?.[1] ?? shortHash(read('MERGE_HEAD') ?? '');
        return { text: `Merging branch ${other} into branch ${branch}`, yours: `Yours (${branch})`, theirs: `Theirs (${other})` };
      }
      case 'rebase': {
        const onto = shortHash(read('rebase-merge/onto') ?? read('rebase-apply/onto') ?? '');
        const head = repo.info.rebaseHeadName;
        return { text: `Rebasing${head ? ` branch ${head}` : ''} onto ${onto}`, yours: `Yours${head ? ` (${head})` : ''}`, theirs: `Theirs (${onto})` };
      }
      case 'cherry-pick': {
        const h = read('CHERRY_PICK_HEAD') ?? '';
        return { text: `Conflicts during cherry-picking commit ${shortHash(h)}`, yours: 'Yours', theirs: `Theirs (${shortHash(h)})` };
      }
      case 'revert': {
        const h = read('REVERT_HEAD') ?? '';
        return { text: `Conflicts during reverting commit ${shortHash(h)}`, yours: 'Yours', theirs: 'Theirs' };
      }
      default:
        return { text: '', yours: 'Yours', theirs: 'Theirs' };
    }
  }

  /** Rows resolved while the dialog is open ("Resolved" group of the iterative Conflicts dialog). */
  private resolved = new Map<string, ConflictRow>();
  private known = new Map<string, ConflictRow>();

  private payload() {
    const rows = this.rows();
    const current = new Set(rows.map(r => r.key));
    for (const [k, r] of this.known) if (!current.has(k)) this.resolved.set(k, r);
    for (const r of rows) {
      this.known.set(r.key, r);
      this.resolved.delete(r.key);
    }
    return { rows, resolved: [...this.resolved.values()], ...this.description() };
  }

  private pushRows() {
    if (!this.dialog) return;
    this.dialog.post('rows', this.payload());
  }

  async show(root?: string) {
    await this.ctx.repos.ready();
    await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
    if (!this.conflicts(root).length) {
      void vscode.window.showInformationMessage('No conflicts to resolve');
      return;
    }
    this.resolved.clear();
    this.known.clear();
    await showDialog('commit.conflicts', this.payload(), {
      title: 'Conflicts',
      onOpen: conn => (this.dialog = conn),
      handlers: {
        load: () => this.payload(),
        accept: (p: { keys: string[]; yours: boolean }) => this.accept(p.keys, p.yours),
        merge: (p: { key: string }) => {
          const c = this.conflicts().find(x => changeKey(x) === p.key);
          if (c) return this.openMergeEditor(c);
        },
        resolveSimple: async () => {
          let n = 0;
          for (const c of this.conflicts()) {
            const repo = this.ctx.repos.get(c.root);
            if (repo && (await resolveSimpleConflict(repo, c))) n++;
          }
          await Promise.all(this.ctx.repos.repositories.map(r => r.refresh()));
          return n;
        },
        showDiff: (p: { key: string }) => {
          const r = this.resolved.get(p.key);
          if (r) return vscode.commands.executeCommand('rebased.showLocalDiff', vscode.Uri.file(path.join(r.root, r.path)));
        },
      },
    });
    this.dialog = undefined;
  }

  async accept(keys: string[], yours: boolean) {
    const list = this.conflicts().filter(c => keys.includes(changeKey(c)));
    const byRoot = new Map<string, Change[]>();
    for (const c of list) byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), c]);
    for (const [root, changes] of byRoot) {
      const repo = this.ctx.repos.get(root)!;
      const side = yours !== this.reversed(repo) ? 'ours' : 'theirs';
      await repo.batch(() => acceptSide(repo, changes, side));
    }
  }

  /** Opens VS Code's 3-way merge editor: base (stage 1), yours, theirs; result written to the work tree file. */
  async openMergeEditor(c: Change) {
    const repo = this.ctx.repos.get(c.root);
    const rev = this.reversed(repo);
    const d = this.description();
    const file = vscode.Uri.file(path.join(c.root, c.path));
    this.pending.set(file.fsPath, { root: c.root, path: c.path });
    const yoursStage = rev ? ':3' : ':2';
    const theirsStage = rev ? ':2' : ':3';
    try {
      await vscode.commands.executeCommand('_open.mergeEditor', {
        base: toGitUri(c.root, c.path, ':1'),
        input1: { uri: toGitUri(c.root, c.path, yoursStage), title: d.yours, description: 'Your version', detail: c.path },
        input2: { uri: toGitUri(c.root, c.path, theirsStage), title: d.theirs, description: 'Changes from the other side', detail: c.path },
        output: file,
      });
    } catch {
      // Older VS Code: open the file with conflict markers.
      await vscode.window.showTextDocument(file);
    }
  }

  private async onSaved(doc: vscode.TextDocument) {
    const p = this.pending.get(doc.uri.fsPath);
    if (!p) return;
    const text = doc.getText();
    if (/^(<{7}|>{7})( |$)/m.test(text)) return;
    this.pending.delete(doc.uri.fsPath);
    const repo = this.ctx.repos.get(p.root);
    if (!repo) return;
    await repo.batch(() => addFiles(repo, [p.path], true));
    void notifySuccess('Conflict resolved', p.path);
  }
}
