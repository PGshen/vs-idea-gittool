import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { showLogOnStartup, StartupDeps } from '../src/features/log/startup';

const read = (file: string) => readFileSync(file, 'utf8');

test('startup log is opt-in in both contribution source and generated manifest', () => {
  const source = JSON.parse(read('contrib/20-log.json'));
  const manifest = JSON.parse(read('package.json'));
  const key = 'ideagittool.log.openOnStartup';
  assert.equal(source.configuration.properties[key].default, false);
  assert.equal(manifest.contributes.configuration.properties[key].default, false);
});

function deps(over: Partial<StartupDeps<string>> = {}) {
  const shown: string[] = [];
  const d: StartupDeps<string> = {
    ready: async () => undefined,
    repo: () => '/repo',
    enabled: () => true,
    alreadyOpen: () => false,
    show: async repo => void shown.push(repo),
    delayMs: 0,
    ...over,
  };
  return { d, shown };
}

test('startup log is not shown when the setting is off', async () => {
  const { d, shown } = deps({ enabled: () => false });
  assert.equal(await showLogOnStartup(d), false);
  assert.deepEqual(shown, []);
});

test('startup log is shown when the user opted in', async () => {
  const { d, shown } = deps();
  assert.equal(await showLogOnStartup(d), true);
  assert.deepEqual(shown, ['/repo']);
});

test('startup log is not shown without a repository or when a restored log is open', async () => {
  for (const over of [{ repo: () => undefined }, { alreadyOpen: () => true }]) {
    const { d, shown } = deps(over);
    assert.equal(await showLogOnStartup(d), false);
    assert.deepEqual(shown, []);
  }
});

test('the opt-in check waits for the repositories', async () => {
  let ready = false;
  const { d, shown } = deps({
    ready: async () => {
      await new Promise(r => setTimeout(r, 5));
      ready = true;
    },
    enabled: () => {
      assert.ok(ready);
      return true;
    },
  });
  await showLogOnStartup(d);
  assert.deepEqual(shown, ['/repo']);
});
