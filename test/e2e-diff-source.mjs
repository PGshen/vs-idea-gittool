// Regression for Jump to Source in the native multi-file diff editor.
// Run: node scripts/e2e.mjs test/e2e-diff-source.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const theme = 'none';
export const settings = {
  'window.menuStyle': 'custom',
  'window.autoDetectHighContrast': false,
};

export function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'ideagittool-diff-source-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const content = marker => `export const value = "${marker}";\n${'// unchanged context\n'.repeat(12)}`;
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'old-a.ts'), content('BEFORE_A'));
  writeFileSync(join(root, 'b.ts'), content('BEFORE_B'));
  git('add', '.');
  git('commit', '-m', 'initial');
  renameSync(join(root, 'old-a.ts'), join(root, 'a.ts'));
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.ts`), content(`HISTORY_${name.toUpperCase()}`));
  git('add', '-A');
  git('commit', '-m', 'diff source regression');
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.ts`), content(`LOCAL_${name.toUpperCase()}`));
  return root;
}

export async function run({ window, shot, sleep }) {
  let log;
  for (let attempt = 0; attempt < 40 && !log; attempt++) {
    for (const frame of window.frames()) {
      if (await frame.locator('.log-row').count().catch(() => 0)) log = frame;
    }
    if (!log) await sleep(250);
  }
  assert.ok(log, 'log is available');
  console.log('OK: log is available');
  await shot('multi-diff-source-before');
  await log.locator('.log-row').filter({ hasText: 'diff source regression' }).dblclick();
  const revisionB = window.locator('.monaco-editor').filter({ hasText: 'HISTORY_B' }).last();
  await revisionB.locator('.view-line').first().click({ button: 'right', position: { x: 90, y: 8 } });
  const jump = window.getByRole('menuitem', { name: /Jump to Source from Diff/ });
  await jump.waitFor({ state: 'visible', timeout: 10000 });
  await shot('multi-diff-source-menu');
  await jump.click();
  await window.locator('.tab.active').filter({ hasText: 'b.ts' }).waitFor();
  await window.locator('.monaco-editor').filter({ hasText: 'LOCAL_B' }).last().waitFor();
  console.log('OK: multi-diff context menu opens the clicked working file');

  await window.locator('.tab').filter({ hasText: '(2 files)' }).click();
  const revisionA = window.locator('.monaco-editor').filter({ hasText: 'HISTORY_A' }).last();
  await revisionA.locator('.view-lines').click();
  await window.keyboard.press('F4');
  await window.locator('.tab.active').filter({ hasText: 'a.ts' }).waitFor();
  await window.locator('.monaco-editor').filter({ hasText: 'LOCAL_A' }).last().waitFor();
  console.log('OK: F4 in multi-diff opens the focused working file');
  await window.locator('.tab').filter({ hasText: '(2 files)' }).click();
  await window.locator('.monaco-editor').filter({ hasText: 'BEFORE_A' }).last().locator('.view-line').first().click();
  await window.keyboard.press('F4');
  await window.locator('.tab.active').filter({ hasText: 'a.ts' }).waitFor();
  await window.locator('.monaco-editor').filter({ hasText: 'LOCAL_A' }).last().waitFor();
  console.log('OK: original side of renamed file opens the current working path');
  await shot('multi-diff-source-open');
}
