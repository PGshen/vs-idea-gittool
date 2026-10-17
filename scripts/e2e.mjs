// Launches the downloaded VS Code with this extension on a sample repository and runs a scenario.
// Usage: xvfb-run -a node scripts/e2e.mjs <scenario.mjs> [workspace]
// The scenario exports `run({ window, shot, command, sleep })`.
import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const [scenarioPath, workspaceArg] = process.argv.slice(2);
const code = resolve('.vscode-test/vscode-linux-x64-1.95.3/code');
const workspace = workspaceArg ? resolve(workspaceArg) : makeSampleRepo();
const userData = mkdtempSync(resolve(tmpdir(), 'rebased-e2e-user-'));
const extDir = mkdtempSync(resolve(tmpdir(), 'rebased-e2e-ext-'));
const outDir = process.env.SHOTS ?? resolve('test/shots');
execSync(`mkdir -p ${outDir}`);
execSync(`mkdir -p ${userData}/User && echo '{"workbench.startupEditor":"none","window.titleBarStyle":"custom","workbench.colorTheme":"Default Dark Modern","security.workspace.trust.enabled":false,"git.enabled":false,"extensions.ignoreRecommendations":true,"workbench.tips.enabled":false,"update.mode":"none","telemetry.telemetryLevel":"off"}' > ${userData}/User/settings.json`);

const app = await electron.launch({
  executablePath: code,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extDir}`,
    `--extensionDevelopmentPath=${resolve('.')}`,
    workspace,
  ],
  env: { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' },
});
const window = await app.firstWindow();
await window.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => {});
window.on('console', m => m.type() === 'error' && console.log('[console]', m.text()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(4000);
const shot = async name => {
  const p = `${outDir}/${name}.png`;
  await window.screenshot({ path: p });
  console.log('shot', p);
};
const command = async title => {
  await window.keyboard.press('F1');
  await sleep(400);
  await window.keyboard.type(title);
  await sleep(500);
  await window.keyboard.press('Enter');
  await sleep(1200);
};
const scenario = await import(pathToFileURL(resolve(scenarioPath)).href);
try {
  await scenario.run({ app, window, shot, command, sleep, workspace });
} finally {
  await app.close();
}

function makeSampleRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'rebased-sample-'));
  const sh = cmd => execSync(cmd, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'detachhead', GIT_AUTHOR_EMAIL: 'detachhead@users.noreply.github.com', GIT_COMMITTER_NAME: 'detachhead', GIT_COMMITTER_EMAIL: 'detachhead@users.noreply.github.com' } });
  sh('git init -q -b master && git config user.name detachhead && git config user.email detachhead@users.noreply.github.com');
  let n = 0;
  const commit = msg => { n++; sh(`mkdir -p src docs && echo "${msg} ${n}" >> src/file${n}.ts && git add -A && git commit -qm "${msg}" --date="2026-06-${String(1 + (n % 28)).padStart(2, '0')}T10:00:00"`); };
  commit('initial commit');
  commit('add build scripts');
  sh('git checkout -qb feature/log-graph');
  commit('draw graph lanes');
  commit('graph colors from DefaultColorGenerator');
  sh('git checkout -q master');
  commit('fix `test.cmd` command');
  commit('update readme screenshot');
  sh('git merge -q --no-ff feature/log-graph -m "Merge branch \'feature/log-graph\'"');
  sh('git checkout -qb feature/shelf');
  commit('shelve changes');
  sh('git checkout -q master');
  commit('fix zizmor errors');
  sh('git tag v1.0');
  commit('update android repo');
  sh('echo readme > README.md && git add README.md && git commit -qm readme && echo "local edit" >> src/file1.ts && echo edit >> README.md && echo new > docs/new.md && git add docs/new.md && echo untracked > notes.txt');
  return dir;
}
