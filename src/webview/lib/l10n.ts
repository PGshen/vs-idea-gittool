// UI text translation for webviews. The host sends the selected language bundle, keyed by the English text.
import { boot } from './rpc';

const bundle: Record<string, string> = boot.l10n ?? {};

/** Translates an English UI string, like vscode.l10n.t: `t('Pushed {0} commits to {1}', n, branch)`. */
export function t(message: string, ...args: (string | number | boolean)[]): string {
  const s = bundle[message] ?? message;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s;
}
