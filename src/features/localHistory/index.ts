import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { relativeTime } from '../../host/ui';
import { LocalHistoryRecorder } from './recorder';
import { normPath } from './store';
import { LH_SCHEME, LocalHistoryView, LhTarget } from './view';

let recorder: LocalHistoryRecorder | undefined;

/** The recorder, for other features (labels before git operations). */
export function localHistory(): LocalHistoryRecorder | undefined {
  return recorder;
}

/**
 * Local History: IntelliJ's LVCS. Records file changes for a few days and shows them in the
 * Local History window, independent of git.
 */
export function register(ctx: Ctx) {
  const rec = new LocalHistoryRecorder(ctx);
  recorder = rec;
  ctx.extension.subscriptions.push(rec);

  ctx.extension.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LH_SCHEME, {
      provideTextDocumentContent(uri) {
        if (uri.query === 'none') return '';
        return rec.store.getContent(uri.query)?.toString('utf8') ?? '';
      },
    }),
  );

  const open = (target: LhTarget, select?: number) => new LocalHistoryView(rec, target, ctx.extension.globalState, select);

  const targetOf = (uri?: unknown): LhTarget => {
    const u = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!u || u.scheme !== 'file') return { mode: 'project' };
    const p = normPath(u.fsPath);
    let dir = false;
    try {
      dir = fs.statSync(u.fsPath).isDirectory();
    } catch {
      // deleted file: show its history
    }
    return { mode: dir ? 'dir' : 'file', path: p };
  };

  ctx.command('rebased.localHistory.showHistory', (uri?: unknown) => open(targetOf(uri)));
  ctx.command('rebased.localHistory.showProjectHistory', () => open({ mode: 'project' }));
  ctx.command('rebased.localHistory.showSelectionHistory', (uri?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a file and select lines to see their history');
      return;
    }
    if (uri instanceof vscode.Uri && normPath(uri.fsPath) !== normPath(editor.document.uri.fsPath)) return open(targetOf(uri));
    const sel = editor.selection;
    const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    open({ mode: 'selection', path: normPath(editor.document.uri.fsPath), selection: [sel.start.line, end] });
  });
  ctx.command('rebased.localHistory.putLabel', async () => {
    const name = await vscode.window.showInputBox({ title: 'Put Label', prompt: 'Label name:', ignoreFocusOut: true, validateInput: v => (v.trim() ? undefined : 'Label name is empty') });
    if (!name?.trim()) return;
    rec.putLabel(name.trim());
    void vscode.window.setStatusBarMessage(`Label ${name.trim()} created`, 4000);
  });
  // For other features: "Before Update", "Before Rebase", … labels recorded around git operations.
  ctx.command('rebased.localHistory.putSystemLabel', (arg?: { root?: string; label: string } | string) => {
    const label = typeof arg === 'string' ? arg : arg?.label;
    if (label) rec.putLabel(label, true);
  });
  ctx.command('rebased.localHistory.recentChanges', async () => {
    const picks = { items: [] as { id: number; label: string; description: string; detail?: string }[] };
    // Reuse the project grouping of the view without opening it.
    const groups = new Map<number, number[]>();
    for (const e of rec.store.events) {
      if (e.kind === 'system') continue;
      const key = e.kind === 'label' ? -e.id : e.group;
      groups.set(key, [...(groups.get(key) ?? []), e.id]);
    }
    const byId = new Map(rec.store.events.map(e => [e.id, e]));
    for (const ids of groups.values()) {
      const evs = ids.map(i => byId.get(i)!);
      const first = evs[0];
      const files = evs.filter(e => e.path).map(e => path.posix.basename(e.path!));
      const label =
        first.kind === 'label'
          ? `$(tag) ${first.label}`
          : evs.every(e => e.external)
            ? 'External change'
            : files.length > 1
              ? `Change ${files[0]} + ${files.length - 1} more`
              : first.kind === 'create'
                ? `Create ${files[0]}`
                : first.kind === 'delete'
                  ? `Delete ${files[0]}`
                  : first.kind === 'rename'
                    ? `Rename ${path.posix.basename(first.oldPath ?? '')} to ${files[0]}`
                    : `Change ${files[0] ?? ''}`;
      picks.items.push({ id: first.id, label, description: relativeTime(Math.floor(evs[evs.length - 1].ts / 1000)) });
    }
    picks.items.sort((a, b) => b.id - a.id);
    if (!picks.items.length) {
      void vscode.window.showInformationMessage('There are no changes');
      return;
    }
    const picked = await vscode.window.showQuickPick(picks.items.slice(0, 200), { title: 'Recent Changes', placeHolder: 'Search recent changes' });
    if (picked) open({ mode: 'project' }, picked.id);
  });
}
