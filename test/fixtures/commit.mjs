// Fixture for `node scripts/preview.mjs commit test/fixtures/commit.mjs out.png --size=360x900`.
// Mirrors the IdeaGitTool screenshot: "Changes 2 files" with README.md and screenshot.png, "Unversioned Files 2 files".
const root = '/home/user/ideagittool';
const ch = (path, status) => ({ root, path, status, index: '.', workTree: 'M' });
const changes = [ch('README.md', 'M'), ch('screenshot.png', 'M')];
const unversioned = [
  { root, path: 'notes.txt', status: '?' },
  { root, path: 'docs/new.md', status: '?' },
];
const key = c => `${c.root}\u0000${c.path}`;
const now = Math.floor(Date.now() / 1000);

export const state = {
  repos: [{ root, name: 'ideagittool', branch: 'master', headHash: 'c1c9c29a', operation: process.env.OP ?? 'none', operationTarget: 'abc12345', rebaseHeadName: 'master' }],
  changelists: [{ id: 'default', name: 'Changes', isDefault: true, files: changes.map(key), changes }],
  unversioned,
  ignored: [],
  conflicts: process.env.OP ? [{ root, path: 'src/conflict.ts', status: 'U', index: 'U', workTree: 'U' }] : [],
  included: [],
  settings: { groupByDirectory: false, groupByRepository: true, showIgnored: false, doubleClick: 'diff', showRecycledShelves: true },
  options: { author: '', signOff: false, extraMoveCommit: false },
  shelves: [
    { id: 's1', root, name: 'WIP on graph colors', date: now - 3600, files: [{ root, path: 'src/graph.ts', status: 'M' }, { root, path: 'src/new.ts', status: 'A' }] },
    { id: 's2', root, name: 'Old experiment', date: now - 86400 * 9, deleted: true, files: [{ root, path: 'README.md', status: 'M' }] },
  ],
  stashes: [
    { index: 0, ref: 'stash@{0}', hash: 'a'.repeat(40), message: 'fix zizmor errors', branch: 'master', date: now - 7200, root, repoName: 'ideagittool' },
    { index: 1, ref: 'stash@{1}', hash: 'b'.repeat(40), message: 'try new toolbar', branch: 'feature/ui', date: now - 86400 * 3, root, repoName: 'ideagittool' },
  ],
  messageHistory: ['update readme screenshot', 'fix `test.cmd` command'],
  loading: false,
};

export const initial = { state, draft: 'update readme screenshot' };

export async function handle(method) {
  if (method === 'ready') return { state, draft: 'update readme screenshot' };
  if (method === 'stashFiles') return [{ root, path: 'src/toolbar.ts', status: 'M', left: 'x^1', right: 'x' }, { root, path: 'src/new.ts', status: 'A', left: '', right: 'x^3' }];
  return null;
}

const tab = process.env.TAB;
export async function act(page) {
  if (tab) await page.click(`.tw-tab:text("${tab}")`);
  if (process.env.MENU) {
    const row = await page.$('.tree-row:has-text("README.md")');
    await row.click({ button: 'right' });
  }
  if (process.env.OPTIONS) await page.click('.commit-buttons .action-button');
}
