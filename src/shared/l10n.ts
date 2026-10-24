// Translation for UI text built by shared code. Shared code cannot use vscode.l10n or the webview bundle, so its
// callers pass their t (vscode.l10n.t on the host, t of src/webview/lib/l10n.ts in webviews). See l10n/README.md.

export type Translate = (message: string, ...args: (string | number | boolean)[]) => string;

/** The English text with the {n} placeholders filled in. */
export const english: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m));
