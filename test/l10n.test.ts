import { afterEach, mock, test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { initLanguage } from '../src/host/l10n';
import { english, getTranslationBundle, setTranslationBundle, translate } from '../src/shared/l10n';

afterEach(() => {
  mock.restoreAll();
  setTranslationBundle(undefined);
});

const extension = { asAbsolutePath: (path: string) => resolve(path) };

function mockVsCodeBundle(t: TestContext, bundle: Record<string, string>) {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.l10n, 'bundle');
  assert.ok(descriptor);
  Object.defineProperty(vscode.l10n, 'bundle', { configurable: true, value: bundle });
  t.after(() => Object.defineProperty(vscode.l10n, 'bundle', descriptor));
}

test('translate uses the selected bundle and falls back to English', () => {
  setTranslationBundle({ 'Pushed {0} commits to {1}': '已推送 {0} 个提交到 {1}' });
  assert.equal(translate('Pushed {0} commits to {1}', 2, 'main'), '已推送 2 个提交到 main');

  setTranslationBundle(undefined);
  assert.equal(translate('Pushed {0} commits to {1}', 2, 'main'), 'Pushed 2 commits to main');
});

test('English overrides the VS Code bundle', t => {
  mockVsCodeBundle(t, { Changes: '更改' });
  mock.method(vscode.workspace, 'getConfiguration', () => ({ get: () => 'en' }));
  initLanguage(extension);
  assert.equal(translate('Changes'), 'Changes');
  assert.equal(getTranslationBundle(), undefined);
});

test('Simplified Chinese loads the shipped bundle regardless of the VS Code language', t => {
  mockVsCodeBundle(t, { Changes: 'VS Code label' });
  mock.method(vscode.workspace, 'getConfiguration', () => ({ get: () => 'zh-cn' }));
  initLanguage(extension);
  assert.equal(translate('Changes'), '更改');
  assert.equal(translate('Reload Window'), '重载窗口');
  assert.equal(translate('Missing translation {0}', 7), 'Missing translation 7');
});

test('system defaults to the VS Code bundle', t => {
  mockVsCodeBundle(t, { Changes: 'VS Code label' });
  initLanguage(extension);
  assert.equal(getTranslationBundle(), vscode.l10n.bundle);
  assert.equal(translate('Changes'), 'VS Code label');
});

test('system uses English when VS Code has no bundle', () => {
  initLanguage(extension);
  assert.equal(getTranslationBundle(), vscode.l10n.bundle);
  assert.equal(translate('Changes'), 'Changes');
});

test('translation preserves missing placeholders and substitutes values without interpreting them', () => {
  setTranslationBundle({ '{0} then {1}': '{1} then {0}' });
  assert.equal(translate('{0} then {1}', '$&'), '{1} then $&');
  assert.equal(translate('{0} then {1}', false, 0), '0 then false');
  assert.equal(english('{0} then {1}', false, 0), 'false then 0');
});
