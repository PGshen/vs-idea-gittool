// Webview side of the host <-> webview protocol, see src/host/webviewHost.ts.

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

/** Bootstrap data the host embeds in the page. */
export interface BootData {
  iconsBase: string;
  /** 'ij-vscode' ("vscode" appearance, default) | 'ij-dark' | 'ij-light' ("intellij" appearance) */
  themeClass: string;
  dark: boolean;
  initial: any;
  /** Translations of the UI language (vscode.l10n.bundle), see l10n.ts. */
  l10n?: Record<string, string>;
}

export const boot: BootData = JSON.parse(document.getElementById('boot')!.textContent!);

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const listeners = new Map<string, Set<(data: any) => void>>();

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg?.type === 'res') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } else if (msg?.type === 'evt') {
    if (msg.name === 'theme') applyTheme(msg.data);
    listeners.get(msg.name)?.forEach(l => l(msg.data));
  }
});

/** Calls a host handler and waits for its result. */
export function call<T = any>(method: string, params?: any): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    vscode.postMessage({ type: 'req', id, method, params });
  });
}

/** Calls a host handler, ignoring the result. Errors are shown by the host. */
export function send(method: string, params?: any): void {
  call(method, params).catch(() => undefined);
}

/** Subscribes to a host event. Returns an unsubscribe function. */
export function on(name: string, cb: (data: any) => void): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

export const theme = { dark: boot.dark };

function applyTheme(data: { themeClass: string; dark: boolean }) {
  document.body.classList.remove('ij-dark', 'ij-light', 'ij-vscode');
  document.body.classList.add(data.themeClass);
  theme.dark = data.dark;
  listeners.get('themeChanged')?.forEach(l => l(data));
}

applyTheme({ themeClass: boot.themeClass, dark: boot.dark });

/** Persists small UI state (splitter sizes, toggles) across webview reloads. */
export function persisted<T>(key: string, def: T): T {
  const s = vscode.getState() ?? {};
  return key in s ? s[key] : def;
}

export function persist(key: string, value: unknown) {
  const s = vscode.getState() ?? {};
  s[key] = value;
  vscode.setState(s);
}
