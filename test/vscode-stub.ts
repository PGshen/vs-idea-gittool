// Minimal stand-in for the vscode module so that host logic can run in node:test.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter(x => x !== l)) };
  };
  fire(e: T) {
    this.listeners.forEach(l => l(e));
  }
  dispose() {}
}
export const workspace = {
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  workspaceFolders: [],
};
export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}
export const Uri = { file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }), joinPath: (u: { fsPath: string }, ...p: string[]) => ({ fsPath: [u.fsPath, ...p].join('/') }) };
export const window = { createOutputChannel: () => ({ appendLine() {}, show() {} }) };
export class Disposable {
  constructor(private fn: () => void) {}
  dispose() {
    this.fn();
  }
}
