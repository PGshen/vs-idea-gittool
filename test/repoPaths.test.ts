import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { RepositoryManager } from '../src/git/manager';

// Issue #13: a remote workspace opened through a symlinked directory (/home/x -> /data/home/x).
// Git reports the real repository root, VS Code reports files under the alias.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'igt-symlink-')));
const realHome = path.join(base, 'data', 'home');
const aliasHome = path.join(base, 'home');
const realRepo = path.join(realHome, 'repo');
const aliasRepo = path.join(aliasHome, 'repo');
fs.mkdirSync(path.join(realRepo, 'src'), { recursive: true });
fs.symlinkSync(realHome, aliasHome, 'junction');
const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: realRepo, stdio: 'pipe' });
gitIn('init', '-q');
fs.writeFileSync(path.join(realRepo, 'src', 'a.ts'), 'a\n');
fs.writeFileSync(path.join(realRepo, '..ignored-name.ts'), 'x\n');
let leafSymlink = true;
try {
  fs.symlinkSync(path.join('src', 'a.ts'), path.join(realRepo, 'link.ts'));
} catch {
  leafSymlink = false; // file symlinks need privileges on Windows
}

const context = { workspaceState: { get: <T>(_: string, d: T) => d, update: async () => {} } } as unknown as vscode.ExtensionContext;

async function openedThroughAlias() {
  const repos = new RepositoryManager(context);
  const repo = await repos.open(aliasRepo, false);
  assert.ok(repo);
  return { repos, repo };
}

test('a repository opened through a directory alias is keyed by its real root', async () => {
  const { repos, repo } = await openedThroughAlias();
  assert.equal(repo.root, realRepo);
  assert.equal(await repos.open(realRepo, false), repo, 'alias and real path are the same repository');
});

test('a file opened through a symlinked ancestor belongs to the repository', async () => {
  const { repos, repo } = await openedThroughAlias();
  const file = path.join(aliasRepo, 'src', 'a.ts');
  assert.equal(repos.getForFile(file), repo);
  assert.equal(repo.relPath(file), 'src/a.ts');
  assert.equal(repos.getForFile(path.join(realRepo, 'src', 'a.ts')), repo);
  assert.equal(repos.getForFile(aliasRepo), repo, 'the aliased root folder itself');
  assert.equal(repo.relPath(aliasRepo), '');
});

test('a deleted file below an aliased directory still maps into the repository', async () => {
  const { repos, repo } = await openedThroughAlias();
  const file = path.join(aliasRepo, 'gone', 'deeper', 'x.ts');
  assert.equal(repos.getForFile(file), repo);
  assert.equal(repo.relPath(file), 'gone/deeper/x.ts');
});

test('a tracked symlink keeps its own path, not its target', { skip: !leafSymlink }, async () => {
  const { repos, repo } = await openedThroughAlias();
  const file = path.join(aliasRepo, 'link.ts');
  assert.equal(repos.getForFile(file), repo);
  assert.equal(repo.relPath(file), 'link.ts');
});

test('files outside the repository stay outside; names starting with ".." stay inside', async () => {
  const { repos, repo } = await openedThroughAlias();
  assert.equal(repos.getForFile(path.join(aliasHome, 'other.ts')), undefined);
  assert.equal(repos.getForFile(path.join(base, 'elsewhere', 'x.ts')), undefined);
  assert.equal(repos.getForFile(''), undefined);
  assert.equal(repos.getForFile(path.join(aliasRepo, '..ignored-name.ts')), repo);
});
