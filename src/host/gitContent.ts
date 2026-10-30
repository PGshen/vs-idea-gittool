import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../shared/l10n';
import { RepositoryManager } from '../git/manager';
import { Change } from '../shared/types';

export const GIT_SCHEME = 'ideagittool-git';

/** Special revisions understood by the content provider. */
export const REV_EMPTY = '~empty';
export const REV_INDEX = ':0';

interface GitUriQuery {
  root: string;
  path: string;
  ref: string;
  /** Current path when the original side of a multi-diff is a renamed file. */
  sourcePath?: string;
}

/** Builds a read-only URI that shows `relPath` at revision `ref`. */
export function toGitUri(root: string, relPath: string, ref: string, sourcePath?: string): vscode.Uri {
  const query: GitUriQuery = { root, path: relPath, ref, sourcePath };
  return vscode.Uri.file(path.join(root, relPath)).with({ scheme: GIT_SCHEME, query: JSON.stringify(query) });
}

export function fromGitUri(uri: vscode.Uri): GitUriQuery {
  return JSON.parse(uri.query) as GitUriQuery;
}

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly repos: RepositoryManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return (await this.readFile(uri)).toString();
  }

  // A read-only file system provider gives binary support (images) and proper language detection.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const data = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.length, permissions: vscode.FilePermission.Readonly };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const q = fromGitUri(uri);
    if (q.ref === REV_EMPTY) return new Uint8Array();
    await this.repos.ready();
    const repo = this.repos.get(q.root) ?? (await this.repos.open(q.root, false));
    if (!repo) return new Uint8Array();
    return repo.show(q.ref, q.path);
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}

export function shortHash(ref: string) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}

function revLabel(ref: string) {
  if (ref === REV_EMPTY) return translate('Empty');
  if (ref === REV_INDEX) return translate('Staged');
  if (ref === 'WORKTREE') return translate('Local');
  return shortHash(ref);
}

/**
 * Opens a diff of one change between two revisions.
 * `right` may be 'WORKTREE' to compare with the local file.
 */
export async function openChangeDiff(
  change: Change,
  left: string,
  right: string,
  opts: { preview?: boolean; viewColumn?: vscode.ViewColumn; preserveFocus?: boolean } = {},
): Promise<{ original: vscode.Uri; modified: vscode.Uri }> {
  const leftPath = change.oldPath ?? change.path;
  const leftUri = change.status === 'A' || change.status === '?' ? toGitUri(change.root, leftPath, REV_EMPTY) : toGitUri(change.root, leftPath, left);
  let rightUri: vscode.Uri;
  if (change.status === 'D') rightUri = toGitUri(change.root, change.path, REV_EMPTY);
  else if (right === 'WORKTREE') rightUri = vscode.Uri.file(path.join(change.root, change.path));
  else rightUri = toGitUri(change.root, change.path, right);
  const name = path.posix.basename(change.path);
  const title = `${name} (${revLabel(left)} ↔ ${revLabel(right)})`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
    preview: opts.preview ?? true,
    viewColumn: opts.viewColumn,
    preserveFocus: opts.preserveFocus,
  } satisfies vscode.TextDocumentShowOptions);
  return { original: leftUri, modified: rightUri };
}

/**
 * Opens a multi-file diff (VS Code "changes" editor), like IntelliJ's diff window with file navigation.
 */
export async function openMultiDiff(title: string, changes: Change[], left: (c: Change) => string, right: (c: Change) => string) {
  const resources = changes.map(c => {
    const l = left(c);
    const r = right(c);
    const leftUri = c.status === 'A' || c.status === '?' ? undefined : toGitUri(c.root, c.oldPath ?? c.path, l, c.path);
    const rightUri = c.status === 'D' ? undefined : r === 'WORKTREE' ? vscode.Uri.file(path.join(c.root, c.path)) : toGitUri(c.root, c.path, r);
    return [vscode.Uri.file(path.join(c.root, c.path)), leftUri, rightUri];
  });
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}
