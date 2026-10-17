// Checks that a styling change did not move anything: renders every preview fixture with a base build
// (default: HEAD, IntelliJ dark appearance; both renders get the --vscode-* variables of a real webview) and with the working tree build (VS Code dark appearance), and
// compares the bounding box of every element. Fails on any difference larger than 0.5px.
// Usage: node scripts/layout-check.mjs [--base=<git ref>] [--after=intellij|vscode] [--only=<case substring>]
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = arg('base') ?? 'HEAD';
const after = arg('after') ?? 'vscode';
const only = arg('only');
const TOLERANCE = 0.5;

const dialog = (fixture, env = {}) => ({ bundle: 'dialog', fixture, env, size: '1000x700' });
const CASES = [
  { bundle: 'log', fixture: 'log.mjs', env: {}, size: '1400x900' },
  { bundle: 'log', fixture: 'log.mjs', env: { ACT: 'menu' }, size: '1400x900' },
  { bundle: 'log', fixture: 'log.mjs', env: { ACT: 'branches' }, size: '1400x900' },
  ...['bottom', 'right', 'unified', 'branches'].map(l => ({ bundle: 'log', fixture: 'log-gaps.mjs', env: { LAYOUT: l }, size: '1400x900' })),
  ...['changesMenu', 'graphMenu', 'viewMenu'].map(a => ({ bundle: 'log', fixture: 'log-gaps.mjs', env: { ACT: a }, size: '1400x900' })),
  { bundle: 'commit', fixture: 'commit.mjs', env: {}, size: '380x900' },
  { bundle: 'commit', fixture: 'commit.mjs', env: { TAB: 'Shelf' }, size: '380x900' },
  { bundle: 'commit', fixture: 'commit.mjs', env: { TAB: 'Stash' }, size: '380x900' },
  { bundle: 'commit', fixture: 'commit.mjs', env: { OP: 'rebase' }, size: '380x900' },
  { bundle: 'commit', fixture: 'commit.mjs', env: { MENU: '1' }, size: '380x900' },
  { bundle: 'commit', fixture: 'commit.mjs', env: { OPTIONS: '1' }, size: '380x900' },
  dialog('confirm.mjs'),
  ...['rollback', 'shelve', 'changelist', 'stash', 'unstash', 'conflicts'].map(k => dialog('commit-dialogs.mjs', { KIND: `commit.${k}` })),
  dialog('commit-patch.mjs'),
  dialog('log-dialogs.mjs'),
  ...['reset', 'newBranch', 'update', 'newWorktree', 'rebase', 'pull', 'tag', 'remotes', 'clone', 'smartOperation', 'pushRejected', 'commitMessage'].map(k =>
    dialog('ops-dialogs.mjs', { DIALOG: `ops.${k}` }),
  ),
  dialog('ops-push.mjs'),
  dialog('ops-irebase.mjs'),
  { bundle: 'merge', fixture: 'merge.mjs', env: {}, size: '1400x800' },
  { bundle: 'merge', fixture: 'merge.mjs', env: { MERGE_COLLAPSE: '1' }, size: '1400x800' },
  ...['apply', 'menu', 'edit', 'undo'].map(a => ({ bundle: 'merge', fixture: 'merge.mjs', env: { MERGE_ACT: a }, size: '1400x800' })),
  { bundle: 'localHistory', fixture: 'localHistory.mjs', env: {}, size: '1400x800' },
].filter(c => !only || `${c.bundle} ${c.fixture} ${JSON.stringify(c.env)}`.includes(only));

// Build the base revision in a temporary worktree.
const tmp = mkdtempSync(join(tmpdir(), 'rebased-layout-'));
const baseDir = join(tmp, 'base');
execSync(`git worktree add --detach ${baseDir} ${base}`, { stdio: 'pipe' });
try {
  symlinkSync(resolve('node_modules'), join(baseDir, 'node_modules'));
  execSync('node scripts/build.mjs', { cwd: baseDir, stdio: 'pipe' });
  if (!existsSync('dist/webview/log.js')) execSync('node scripts/build.mjs', { stdio: 'pipe' });

  let failed = 0;
  for (const c of CASES) {
    const name = `${c.bundle} ${c.fixture} ${JSON.stringify(c.env)}`;
    const render = (dist, theme) => {
      const out = join(tmp, `${Math.random().toString(36).slice(2)}.json`);
      execFileSync(
        process.execPath,
        ['scripts/preview.mjs', c.bundle, `test/fixtures/${c.fixture}`, '-', `--size=${c.size}`, `--dist=${dist}`, `--rects=${out}`, ...theme],
        { env: { ...process.env, ...c.env }, stdio: 'pipe' },
      );
      return JSON.parse(readFileSync(out, 'utf8'));
    };
    const before = render(join(baseDir, 'dist'), ['--vars=dark']);
    const now = render('dist', after === 'vscode' ? ['--vscode=dark'] : ['--vars=dark']);
    const diffs = [];
    if (before.length !== now.length) diffs.push(`element count ${before.length} -> ${now.length}`);
    for (let i = 0; i < Math.min(before.length, now.length); i++) {
      const [ka, ...a] = before[i];
      const [kb, ...b] = now[i];
      const tagA = ka.split('.')[0];
      const tagB = kb.split('.')[0];
      if (tagA !== tagB) {
        diffs.push(`#${i} element ${ka} -> ${kb}`);
        break;
      }
      if (a.some((v, j) => Math.abs(v - b[j]) > TOLERANCE)) diffs.push(`#${i} ${ka}: [${a.map(v => v.toFixed(1))}] -> [${b.map(v => v.toFixed(1))}]`);
    }
    if (diffs.length) {
      failed++;
      console.log(`FAIL ${name}: ${diffs.length} differences`);
      diffs.slice(0, 8).forEach(d => console.log(`  ${d}`));
    } else console.log(`ok   ${name} (${now.length} elements)`);
  }
  console.log(failed ? `\n${failed} of ${CASES.length} cases differ` : `\nAll ${CASES.length} cases identical (tolerance ${TOLERANCE}px)`);
  process.exitCode = failed ? 1 : 0;
} finally {
  execSync(`git worktree remove --force ${baseDir}`, { stdio: 'pipe' });
  rmSync(tmp, { recursive: true, force: true });
}
