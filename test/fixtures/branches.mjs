// Fixture for the Branches tab of the Commit tool window:
// `node scripts/preview.mjs commit test/fixtures/branches.mjs out.png --size=420x820 [--vscode=dark|light] [--light]`.
// Mirrors the user's IntelliJ screenshot: repository gvideo-open on pgs/prompt_opt, "dev" is a favorite.
import { state as commitState } from './commit.mjs';

const root = '/home/user/gvideo-open';
const local = (name, extra = {}) => ({ name, fullName: `refs/heads/${name}`, type: 'local', ...extra });
const remote = name => ({ name, fullName: `refs/remotes/${name}`, type: 'remote', remote: name.split('/')[0] });
const tag = name => ({ name, fullName: `refs/tags/${name}`, type: 'tag' });

const mac = process.env.MAC === '1';
const op = process.env.OP ?? 'none';
const top = [
  { label: 'Update Project…', icon: 'vcs/update', shortcut: mac ? '⌘T' : 'Ctrl+T', action: 'ideagittool.updateProject' },
  { label: 'Commit…', icon: 'vcs/commit', shortcut: mac ? '⌘K' : 'Ctrl+K', action: 'ideagittool.commit' },
  { label: 'Push…', icon: 'vcs/push', shortcut: mac ? '⇧⌘K' : 'Ctrl+Shift+K', action: 'ideagittool.push' },
  { label: '', separator: true },
  ...(op === 'rebase'
    ? [
        { label: 'Abort Rebase', icon: 'vcs/abort', action: 'ideagittool.abortOperation' },
        { label: 'Continue Rebase', icon: 'dvcs/resolveContinue', action: 'ideagittool.continueOperation' },
        { label: 'Skip Commit', icon: 'dvcs/skipCommit', action: 'ideagittool.skipCommit' },
      ]
    : []),
  { label: 'New Branch…', icon: 'general/add', shortcut: mac ? '⌥⌘N' : 'Ctrl+Alt+N', action: 'ideagittool.createBranch' },
  { label: 'Checkout Tag or Revision…', action: 'ideagittool.checkoutTagOrRevision' },
];

export const branchesState = {
  mac,
  repos: [
    {
      root,
      name: 'gvideo-open',
      branch: 'pgs/prompt_opt',
      operation: op,
      recent: ['pgs/feature_flags', 'dev'],
      refs: [
        local('pgs/prompt_opt', { current: true, upstream: 'origin/pgs/prompt_opt', ahead: 2 }),
        local('pgs/antispam', { upstream: 'origin/pgs/antispam', behind: 3 }),
        local('pgs/feature_flags'),
        local('dev', { favorite: true, upstream: 'origin/dev' }),
        local('master', { upstream: 'origin/master' }),
        remote('origin/master'),
        remote('origin/dev'),
        remote('origin/pgs/prompt_opt'),
        remote('origin/pgs/antispam'),
        remote('origin/release/2026.10'),
        tag('v1.4.0'),
        tag('v1.3.2'),
      ],
    },
  ],
  sync: false,
  common: [],
  top,
  settings: { groupByDirectory: true, groupByRepository: true, showRecent: true, showTags: true, searchActions: true, syncControl: true },
  fetching: false,
};

export const initial = { state: commitState, draft: '' };

export async function handle(method) {
  if (method === 'ready') return { state: commitState, draft: '', tab: 'branches' };
  if (method === 'branches.ready') return branchesState;
  if (method === 'branches.refActions')
    return [
      { label: 'Checkout', action: 'ideagittool.branch.checkout' },
      { label: "New Branch from 'dev'…", icon: 'general/add', action: 'x' },
      { label: "Checkout and Rebase onto 'pgs/prompt_opt'", action: 'x' },
      { label: 'Checkout and Update', action: 'x' },
      { label: "New Worktree from 'dev'…", action: 'x' },
      { label: '', separator: true },
      { label: "Compare with 'pgs/prompt_opt'", action: 'x' },
      { label: 'Show Diff with Working Tree', icon: 'vcs/diff', action: 'x' },
      { label: '', separator: true },
      { label: "Rebase 'pgs/prompt_opt' onto 'dev'", action: 'x' },
      { label: "Merge 'dev' into 'pgs/prompt_opt'", icon: 'vcs/merge', action: 'x' },
      { label: '', separator: true },
      { label: 'Update', icon: 'vcs/update', action: 'x' },
      { label: 'Push…', icon: 'vcs/push', shortcut: mac ? '⇧⌘K' : 'Ctrl+Shift+K', action: 'x' },
      { label: "Tracked Branch 'origin/dev'…", action: 'x' },
      { label: '', separator: true },
      { label: 'Rename…', shortcut: 'F2', action: 'x' },
      { label: 'Delete', icon: 'general/delete', shortcut: mac ? '⌫' : 'Delete', action: 'x' },
    ];
  return null;
}

export async function act(page) {
  if (process.env.SELECT) {
    const row = await page.$(`.branches-row:has-text("${process.env.SELECT}")`);
    await row?.hover();
  }
  if (process.env.QUERY) {
    await page.click('.branches-search-input');
    await page.keyboard.type(process.env.QUERY);
  }
  if (process.env.SUBMENU) {
    const row = await page.$(`.branches-row.branch:has-text("${process.env.SUBMENU}")`);
    await row?.click();
    await page.waitForTimeout(400);
  }
}
