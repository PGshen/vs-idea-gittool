import * as vscode from 'vscode';
import { GitError } from '../git/exec';
import { getTranslationBundle, translate } from '../shared/l10n';

export type Handler = (params: any) => unknown | Promise<unknown>;

/** Theme class for the webview body, from the `ideagittool.appearance` setting. */
export function themeData() {
  const kind = vscode.window.activeColorTheme.kind;
  const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  const appearance = vscode.workspace.getConfiguration('ideagittool').get<string>('appearance', 'vscode');
  const themeClass = appearance === 'vscode' ? 'ij-vscode' : dark ? 'ij-dark' : 'ij-light';
  return { themeClass, dark };
}

let extensionUri: vscode.Uri;

export function initWebviewHost(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
}

export function getExtensionUri() {
  return extensionUri;
}

/**
 * Connects one webview (panel or view) to a bundle in dist/webview and a set of RPC handlers.
 * Webview -> host: {type:'req', id, method, params}; host -> webview: {type:'res', id, result|error} and {type:'evt', name, data}.
 */
export class WebviewConnection implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(
    readonly webview: vscode.Webview,
    private readonly bundle: string,
    private readonly initial: () => unknown,
    private readonly title = 'IdeaGitTool',
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    };
    webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => this.post('theme', themeData()), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      e => {
        if (e.affectsConfiguration('ideagittool.appearance')) this.post('theme', themeData());
      },
      null,
      this.disposables,
    );
    this.render();
  }

  /** Re-creates the page (initial state is read again). */
  render() {
    this.webview.html = this.html();
  }

  handle(method: string, fn: Handler): this {
    this.handlers.set(method, fn);
    return this;
  }

  handleAll(map: Record<string, Handler>): this {
    for (const [k, v] of Object.entries(map)) this.handlers.set(k, v);
    return this;
  }

  /** Sends an event to the webview. */
  post(name: string, data?: unknown) {
    void this.webview.postMessage({ type: 'evt', name, data });
  }

  private async onMessage(m: any) {
    if (m?.type !== 'req') return;
    const h = this.handlers.get(m.method);
    if (!h) {
      void this.webview.postMessage({ type: 'res', id: m.id, error: `Unknown method ${m.method}` });
      return;
    }
    try {
      const result = await h(m.params);
      void this.webview.postMessage({ type: 'res', id: m.id, result: result ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof CancelledError)) showError(e);
      void this.webview.postMessage({ type: 'res', id: m.id, error: message });
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const asUri = (...p: string[]) => this.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
    const boot = { iconsBase: asUri('media', 'icons'), ...themeData(), initial: this.initial(), l10n: getTranslationBundle() };
    const csp = [
      `default-src 'none'`,
      `img-src ${this.webview.cspSource} data: https:`,
      `style-src ${this.webview.cspSource} 'unsafe-inline'`,
      `font-src ${this.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    // JSON inside <script type="application/json"> must not contain "</".
    const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asUri('dist', 'webview', `${this.bundle}.css`)}">
<title>${this.title}</title>
</head>
<body class="${boot.themeClass}">
<div id="root"></div>
<script type="application/json" id="boot">${bootJson}</script>
<script nonce="${nonce}" src="${asUri('dist', 'webview', `${this.bundle}.js`)}"></script>
</body>
</html>`;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Thrown when the user cancels; never shown as an error. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Shows an error notification like IntelliJ's error balloons, with a link to the Git console. */
export function showError(e: unknown, title?: string) {
  if (e instanceof CancelledError) return;
  const msg = e instanceof GitError ? e.message : e instanceof Error ? e.message : String(e);
  const text = title ? translate('{0}: {1}', title, msg) : msg;
  void vscode.window.showErrorMessage(text, translate('Show Git Console')).then(a => {
    if (a) void vscode.commands.executeCommand('ideagittool.showConsole');
  });
}
