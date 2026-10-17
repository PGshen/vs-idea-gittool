import * as path from 'node:path';
import * as vscode from 'vscode';
import { RepositoryManager } from '../../git/manager';
import { ChangeStatus } from '../../shared/types';

const COLORS: Partial<Record<ChangeStatus, { color: string; tooltip: string }>> = {
  M: { color: 'rebased.fileStatus.modified', tooltip: 'Modified' },
  R: { color: 'rebased.fileStatus.modified', tooltip: 'Renamed' },
  T: { color: 'rebased.fileStatus.modified', tooltip: 'Type changed' },
  C: { color: 'rebased.fileStatus.added', tooltip: 'Copied' },
  A: { color: 'rebased.fileStatus.added', tooltip: 'Added' },
  D: { color: 'rebased.fileStatus.deleted', tooltip: 'Deleted' },
  U: { color: 'rebased.fileStatus.conflict', tooltip: 'Merged with conflicts' },
  '?': { color: 'rebased.fileStatus.unknown', tooltip: 'Unversioned' },
  '!': { color: 'rebased.fileStatus.ignored', tooltip: 'Ignored' },
};

/**
 * Colors file names in the Explorer and editor tabs by VCS status, like IntelliJ's file status colors.
 * IntelliJ shows no letters; the name color is the only marker.
 */
export class StatusDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private map = new Map<string, ChangeStatus>();

  constructor(private readonly repos: RepositoryManager) {
    repos.onDidChangeRepository(() => this.rebuild());
    repos.onDidChangeRepositories(() => this.rebuild());
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('rebased.fileStatusColors') && this.rebuild());
  }

  private rebuild() {
    const old = this.map;
    const next = new Map<string, ChangeStatus>();
    for (const r of this.repos.repositories) {
      for (const c of [...r.status.changes, ...r.status.unversioned, ...r.status.ignored]) next.set(path.join(r.root, c.path), c.status);
    }
    this.map = next;
    const changed = new Set<string>();
    for (const [k, v] of next) if (old.get(k) !== v) changed.add(k);
    for (const k of old.keys()) if (!next.has(k)) changed.add(k);
    if (changed.size) this.emitter.fire([...changed].map(f => vscode.Uri.file(f)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('rebased').get<boolean>('fileStatusColors', true)) return undefined;
    const st = this.map.get(uri.fsPath);
    if (!st) return undefined;
    const c = COLORS[st];
    if (!c) return undefined;
    return { color: new vscode.ThemeColor(c.color), tooltip: c.tooltip };
  }
}
