import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { setTranslationBundle } from '../shared/l10n';

export function initLanguage(extension: Pick<vscode.ExtensionContext, 'asAbsolutePath'>) {
  const language = vscode.workspace.getConfiguration('ideagittool').get<string>('language', 'system');
  const bundle =
    language === 'zh-cn'
      ? (JSON.parse(readFileSync(extension.asAbsolutePath('l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<string, string>)
      : language === 'en'
        ? undefined
        : vscode.l10n.bundle;
  setTranslationBundle(bundle);
}
