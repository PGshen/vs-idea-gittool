import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(file, 'utf8');

test('startup log is opt-in in both contribution source and generated manifest', () => {
  const source = JSON.parse(read('contrib/20-log.json'));
  const manifest = JSON.parse(read('package.json'));
  const key = 'ideagittool.log.openOnStartup';
  assert.equal(source.configuration.properties[key].default, false);
  assert.equal(manifest.contributes.configuration.properties[key].default, false);
});

test('startup opt-in guard runs before delayed panel reveal', () => {
  const source = read('src/features/log/index.ts');
  const startup = source.slice(source.indexOf('// Show the log on startup:'));
  const guard = startup.indexOf("if (!repo || !cfg.get<boolean>('openOnStartup', false)) return;");
  assert.ok(guard >= 0);
  assert.ok(guard < startup.indexOf('setTimeout'));
  assert.ok(guard < startup.indexOf("executeCommand('ideagittool.logView.focus')"));
});
