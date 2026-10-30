import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { RepositoryManager } from '../../git/manager';
import { ChangeStatus } from '../../shared/types';

/**
 * Colors file names in the Explorer and editor tabs by VCS status, like IntelliJ's file status colors.
 * IntelliJ shows no letters; the name color is the only marker.
 */
export class StatusDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private map = new Map<string, ChangeStatus>();
  private readonly colors: Partial<Record<ChangeStatus, { color: string; tooltip: string }>> = {
    M: { color: 'ideagittool.fileStatus.modified', tooltip: translate('Modified') },
    R: { color: 'ideagittool.fileStatus.modified', tooltip: translate('Renamed') },
    T: { color: 'ideagittool.fileStatus.modified', tooltip: translate('Type changed') },
    C: { color: 'ideagittool.fileStatus.added', tooltip: translate('Copied') },
    A: { color: 'ideagittool.fileStatus.added', tooltip: translate('Added') },
    D: { color: 'ideagittool.fileStatus.deleted', tooltip: translate('Deleted') },
    U: { color: 'ideagittool.fileStatus.conflict', tooltip: translate('Merged with conflicts') },
    '?': { color: 'ideagittool.fileStatus.unknown', tooltip: translate('Unversioned') },
    '!': { color: 'ideagittool.fileStatus.ignored', tooltip: translate('Ignored') },
  };

  constructor(private readonly repos: RepositoryManager) {
    repos.onDidChangeRepository(() => this.rebuild());
    repos.onDidChangeRepositories(() => this.rebuild());
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('ideagittool.fileStatusColors') && this.rebuild());
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
    if (uri.scheme !== 'file' || !vscode.workspace.getConfiguration('ideagittool').get<boolean>('fileStatusColors', true)) return undefined;
    const st = this.map.get(uri.fsPath);
    if (!st) return undefined;
    const c = this.colors[st];
    if (!c) return undefined;
    return { color: new vscode.ThemeColor(c.color), tooltip: c.tooltip };
  }
}
