import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { Repository } from '../../git/repository';
import { ShelfFileInfo, ShelfInfo } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';
import { applyPatch, createPatch, deleteFiles, PatchFile, rollbackChanges, splitPatch } from './gitOps';

interface StoredShelf {
  id: string;
  root: string;
  name: string;
  date: number;
  files: (PatchFile & { applied?: boolean })[];
  deleted?: boolean;
}

/**
 * The shelf: IntelliJ's ShelveChangesManager. Every shelved changelist is a binary patch
 * (`<storage>/shelf/<id>.patch`) plus metadata in `shelf.json`. Unversioned files are included.
 */
export class Shelf {
  private dir: string;
  private items: StoredShelf[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(storage: vscode.Uri) {
    this.dir = path.join(storage.fsPath, 'shelf');
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.items = JSON.parse(fs.readFileSync(path.join(this.dir, 'shelf.json'), 'utf8'));
    } catch {
      this.items = [];
    }
  }

  private save() {
    fs.writeFileSync(path.join(this.dir, 'shelf.json'), JSON.stringify(this.items, null, 1));
    this.emitter.fire();
  }

  private patchFile(id: string) {
    return path.join(this.dir, `${id}.patch`);
  }

  readPatch(id: string): string {
    try {
      return fs.readFileSync(this.patchFile(id), 'utf8');
    } catch {
      return '';
    }
  }

  list(): ShelfInfo[] {
    return [...this.items]
      .sort((a, b) => b.date - a.date)
      .map(s => ({
        id: s.id,
        root: s.root,
        name: s.name,
        date: s.date,
        deleted: s.deleted,
        files: s.files.map(f => ({ root: s.root, path: f.path, oldPath: f.oldPath, status: f.status, oldBlob: f.oldBlob, newBlob: f.newBlob }) satisfies ShelfFileInfo),
      }));
  }

  get(id: string) {
    return this.items.find(s => s.id === id);
  }

  /** Saves changes to the shelf; when `rollback`, reverts them in the work tree (Shelve Changes). */
  async shelve(repo: Repository, changes: Change[], name: string, rollback = true): Promise<StoredShelf> {
    const { patch, files } = await createPatch(repo, changes);
    if (!files.length) throw new Error(translate('The selected changes affect only directories and no files, so they cannot be shelved'));
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(this.patchFile(id), patch);
    const item: StoredShelf = { id, root: repo.root, name: name.trim() || translate('Shelved changes'), date: Math.floor(Date.now() / 1000), files };
    this.items.push(item);
    this.save();
    if (rollback) {
      await repo.batch(async () => {
        await rollbackChanges(repo, changes, true);
        deleteFiles(repo, changes.filter(c => c.status === '?').map(c => c.path));
      });
    }
    return item;
  }

  /**
   * Applies shelved files to the work tree. `paths` limits the files (whole shelf otherwise).
   * Applied files are removed from the shelf when `removeApplied`; an empty shelf goes to Recently Deleted.
   */
  async unshelve(repo: Repository, id: string, paths: string[] | undefined, removeApplied: boolean): Promise<{ conflicts: boolean }> {
    const item = this.get(id);
    if (!item) throw new Error(translate('Shelved changeList {0} not found', id));
    const sections = splitPatch(this.readPatch(id));
    const files = item.files.filter(f => !paths || paths.includes(f.path));
    const patch = files.map(f => sections.get(f.path) ?? '').join('');
    const result = await repo.batch(() => applyPatch(repo, patch, files));
    if (removeApplied) {
      const remaining = item.files.filter(f => !files.includes(f));
      if (remaining.length === 0) {
        item.deleted = true;
      } else {
        // Applied files move to a new entry in Recently Deleted, the rest stays.
        const appliedId = `${item.id}-a${Date.now().toString(36)}`;
        fs.writeFileSync(this.patchFile(appliedId), patch);
        this.items.push({ ...item, id: appliedId, files, deleted: true });
        item.files = remaining;
        fs.writeFileSync(this.patchFile(item.id), remaining.map(f => sections.get(f.path) ?? '').join(''));
      }
    }
    this.save();
    return result;
  }

  rename(id: string, name: string) {
    const s = this.get(id);
    if (s) {
      s.name = name;
      this.save();
    }
  }

  /** Delete moves to Recently Deleted; deleting from Recently Deleted removes permanently. */
  delete(ids: string[], permanently = false) {
    for (const id of ids) {
      const s = this.get(id);
      if (!s) continue;
      if (s.deleted || permanently) {
        this.items = this.items.filter(x => x !== s);
        fs.rmSync(this.patchFile(id), { force: true });
      } else s.deleted = true;
    }
    this.save();
  }

  /** Removes files from a shelved changelist. */
  deleteFiles(id: string, paths: string[]) {
    const s = this.get(id);
    if (!s) return;
    const sections = splitPatch(this.readPatch(id));
    s.files = s.files.filter(f => !paths.includes(f.path));
    if (!s.files.length) {
      this.delete([id]);
      return;
    }
    fs.writeFileSync(this.patchFile(id), s.files.map(f => sections.get(f.path) ?? '').join(''));
    this.save();
  }

  restore(ids: string[]) {
    for (const id of ids) {
      const s = this.get(id);
      if (s) s.deleted = false;
    }
    this.save();
  }

  /** Permanently deletes all applied (Recently Deleted) shelves. */
  cleanDeleted() {
    this.delete(this.items.filter(s => s.deleted).map(s => s.id), true);
  }

  /** Patch text of some files of a shelf. */
  patchFor(id: string, paths?: string[]): string {
    const all = this.readPatch(id);
    if (!paths) return all;
    const sections = splitPatch(all);
    return paths.map(p => sections.get(p) ?? '').join('');
  }

  /** Imports a patch file into the shelf. */
  importPatch(root: string, name: string, patch: string) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(this.patchFile(id), patch);
    const files: PatchFile[] = [];
    for (const [p, section] of splitPatch(patch)) {
      const status = /^new file mode/m.test(section) ? 'A' : /^deleted file mode/m.test(section) ? 'D' : /^rename from (.*)$/m.test(section) ? 'R' : 'M';
      const oldPath = /^rename from (.*)$/m.exec(section)?.[1];
      const idx = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(section);
      files.push({ path: p, oldPath, status, oldBlob: idx && !/^0+$/.test(idx[1]) ? idx[1] : undefined, newBlob: idx && !/^0+$/.test(idx[2]) ? idx[2] : undefined });
    }
    this.items.push({ id, root, name, date: Math.floor(Date.now() / 1000), files });
    this.save();
  }
}
