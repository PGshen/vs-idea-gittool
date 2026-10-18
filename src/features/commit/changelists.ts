import * as vscode from 'vscode';
import { changeKey } from '../../shared/commitProtocol';
import { Change, ChangeListInfo } from '../../shared/types';

interface StoredList {
  id: string;
  name: string;
  comment?: string;
}

interface Stored {
  lists: StoredList[];
  activeId: string;
  assignment: Record<string, string>;
}

const KEY = 'ideagittool.changelists';
export const DEFAULT_ID = 'default';

/**
 * IntelliJ's ChangeListManager: named changelists, one of them active. New changes go to the active
 * changelist. Also keeps the commit inclusion (checked files), like the commit workflow handler.
 */
export class ChangeLists {
  private lists: StoredList[];
  private activeId: string;
  private assignment: Map<string, string>;
  private included = new Set<string>();
  /** Keys of changes seen in previous refreshes; new changes in the active list are included by default. */
  private seen = new Set<string>();
  /** Include new changes of the active changelist automatically. */
  autoInclude = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const s = memento.get<Stored>(KEY);
    this.lists = s?.lists?.length ? s.lists : [{ id: DEFAULT_ID, name: 'Changes' }];
    this.activeId = s && this.lists.some(l => l.id === s.activeId) ? s.activeId : this.lists[0].id;
    this.assignment = new Map(Object.entries(s?.assignment ?? {}));
  }

  private save() {
    void this.memento.update(KEY, { lists: this.lists, activeId: this.activeId, assignment: Object.fromEntries(this.assignment) } satisfies Stored);
    this.emitter.fire();
  }

  get active() {
    return this.lists.find(l => l.id === this.activeId)!;
  }

  all(): StoredList[] {
    return this.lists;
  }

  listOf(key: string): string {
    const id = this.assignment.get(key);
    return id && this.lists.some(l => l.id === id) ? id : this.activeId;
  }

  /** Synchronizes with the current local changes. Returns changelists with their changes. */
  sync(changes: Change[], unversioned: Change[]): (ChangeListInfo & { changes: Change[] })[] {
    const keys = new Set<string>();
    let dirty = false;
    for (const c of changes) {
      const k = changeKey(c);
      keys.add(k);
      // IdeaGitTool starts with nothing included (no check marks), unless `ideagittool.commit.includeActiveChangelist`.
      if (this.autoInclude && !this.seen.has(k) && this.listOf(k) === this.activeId) this.included.add(k);
      // A change stays in its changelist when another list becomes active.
      const id = this.assignment.get(k);
      if (!id || !this.lists.some(l => l.id === id)) {
        this.assignment.set(k, this.activeId);
        dirty = true;
      }
    }
    for (const c of unversioned) keys.add(changeKey(c));
    for (const k of [...this.included]) if (!keys.has(k)) this.included.delete(k);
    this.seen = keys;
    for (const k of [...this.assignment.keys()]) {
      if (!keys.has(k)) {
        this.assignment.delete(k);
        dirty = true;
      }
    }
    if (dirty) void this.memento.update(KEY, { lists: this.lists, activeId: this.activeId, assignment: Object.fromEntries(this.assignment) });
    const byList = new Map<string, Change[]>(this.lists.map(l => [l.id, []]));
    for (const c of changes) byList.get(this.listOf(changeKey(c)))!.push(c);
    return this.lists.map(l => ({
      id: l.id,
      name: l.name,
      comment: l.comment,
      isDefault: l.id === this.activeId,
      files: byList.get(l.id)!.map(changeKey),
      changes: byList.get(l.id)!,
    }));
  }

  getIncluded(): string[] {
    return [...this.included];
  }

  setIncluded(keys: string[], value: boolean) {
    for (const k of keys) {
      if (value) this.included.add(k);
      else this.included.delete(k);
    }
    this.emitter.fire();
  }

  setIncludedExactly(keys: string[]) {
    this.included = new Set(keys);
    this.emitter.fire();
  }

  add(name: string, comment?: string, makeActive = false): string {
    const id = `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.lists.push({ id, name, comment });
    if (makeActive) this.activeId = id;
    this.save();
    return id;
  }

  findByName(name: string) {
    return this.lists.find(l => l.name === name);
  }

  edit(id: string, name: string, comment?: string) {
    const l = this.lists.find(x => x.id === id);
    if (!l) return;
    l.name = name;
    l.comment = comment;
    this.save();
  }

  /** Removes a changelist; its changes move to the active one (or to the first other list). */
  remove(id: string) {
    if (this.lists.length <= 1) return;
    this.lists = this.lists.filter(l => l.id !== id);
    if (this.activeId === id) this.activeId = this.lists[0].id;
    for (const [k, v] of this.assignment) if (v === id) this.assignment.delete(k);
    this.save();
  }

  setActive(id: string) {
    if (!this.lists.some(l => l.id === id)) return;
    this.activeId = id;
    this.save();
  }

  move(keys: string[], id: string) {
    for (const k of keys) this.assignment.set(k, id);
    this.save();
  }
}
