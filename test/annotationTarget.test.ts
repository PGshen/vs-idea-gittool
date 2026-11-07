import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workingTreeAnnotation } from '../src/features/log/annotationTarget';

const root = '/home/ming/project';
const file = `${root}/src/中文 file.ts`;
const repository = { relPath: (file: string) => file.slice(root.length + 1) };
const repos = { ready: async () => {}, getForFile: (file: string) => file.startsWith(root + '/') ? repository : undefined };

for (const authority of ['ssh-remote+test-host', 'wsl+Ubuntu', 'dev-container+test']) {
  test(`annotation resolves a workspace remote URI: ${authority}`, async () => {
    const uri = { scheme: 'vscode-remote', authority, fsPath: file };
    assert.deepEqual(await workingTreeAnnotation(repos, uri, [{ uri }]), { repo: repository, path: 'src/中文 file.ts' });
  });
}

test('annotation waits for repository discovery before path lookup', async () => {
  let release!: () => void;
  let lookedUp = false;
  const pending = workingTreeAnnotation({
    ready: () => new Promise<void>(resolve => { release = resolve; }),
    getForFile: () => { lookedUp = true; return repository; },
  }, { scheme: 'file', authority: '', fsPath: file }, []);
  assert.equal(lookedUp, false);
  release();
  assert.equal((await pending)?.path, 'src/中文 file.ts');
  assert.equal(lookedUp, true);
});

test('annotation rejects other hosts and virtual documents', async () => {
  const folders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+ours' } }];
  for (const uri of [
    { scheme: 'vscode-remote', authority: 'ssh-remote+other', fsPath: file },
    { scheme: 'vscode-remote', authority: '', fsPath: file },
    { scheme: 'untitled', authority: '', fsPath: file },
    { scheme: 'github', authority: '', fsPath: file },
  ]) assert.equal(await workingTreeAnnotation(repos, uri, folders), undefined);
});

test('files outside repository remain unrecognized', async () => {
  assert.equal(await workingTreeAnnotation(repos, { scheme: 'file', authority: '', fsPath: '/other/file.ts' }, []), undefined);
});

test('Git integration runs on the workspace extension host', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(manifest.extensionKind, ['workspace']);
});
