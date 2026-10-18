import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refActionModel, shortcut, topActionModel, OPEN_WORKTREE, NEW_WORKTREE } from '../src/features/ops/branchActions';
import { buildBranchRows, matchText } from '../src/shared/branchesTree';
import type { BranchesState } from '../src/shared/branchesProtocol';

const labels = (items: { label: string; separator?: true }[]) => items.map(i => (i.separator ? '—' : i.label));

test('shortcuts use IntelliJ symbols on macOS', () => {
  assert.equal(shortcut('Ctrl+T', true), '⌘T');
  assert.equal(shortcut('Ctrl+Shift+K', true), '⇧⌘K');
  assert.equal(shortcut('Ctrl+Alt+N', true), '⌥⌘N');
  assert.equal(shortcut('Ctrl+Shift+K', false), 'Ctrl+Shift+K');
});

test('top actions as in the branches popup', () => {
  assert.deepEqual(labels(topActionModel(['none'], true)), ['Update Project…', 'Commit…', 'Push…', '—', 'New Branch…', 'Checkout Tag or Revision…']);
  const top = topActionModel(['rebase', 'none'], false);
  assert.deepEqual(labels(top).slice(4, 7), ['Abort Rebase', 'Continue Rebase', 'Skip Commit']);
  assert.equal(top[0].shortcut, 'Ctrl+T');
});

test('local branch submenu (GitBranchPopupActions)', () => {
  const items = refActionModel({ name: 'dev', type: 'local', upstream: 'origin/dev' }, { currentBranch: 'main', mac: true });
  assert.deepEqual(labels(items), [
    'Checkout',
    "New Branch from 'dev'…",
    "Checkout and Rebase onto 'main'",
    'Checkout and Update',
    "New Worktree from 'dev'…",
    '—',
    "Compare with 'main'",
    'Show Diff with Working Tree',
    '—',
    "Rebase 'main' onto 'dev'",
    "Merge 'dev' into 'main'",
    '—',
    'Update',
    'Push…',
    "Tracked Branch 'origin/dev'…",
    '—',
    'Rename…',
    'Delete',
  ]);
  assert.equal(items.find(i => i.label === 'Push…')?.shortcut, '⇧⌘K');
  assert.equal(items.find(i => i.label === "New Worktree from 'dev'…")?.action, NEW_WORKTREE);
});

test('current branch, remote branch and tag submenus', () => {
  assert.deepEqual(labels(refActionModel({ name: 'main', type: 'local', current: true }, { currentBranch: 'main' })), [
    "New Branch from 'main'…",
    '—',
    'Show Diff with Working Tree',
    '—',
    'Update',
    'Push…',
    'Set Tracked Branch…',
    '—',
    'Rename…',
  ]);
  const remote = labels(refActionModel({ name: 'origin/x', type: 'remote' }, { currentBranch: 'main' }));
  assert.ok(remote.includes("Pull into 'main' Using Rebase") && remote.includes("Pull into 'main' Using Merge"));
  assert.ok(!remote.includes('Rename…') && remote.includes('Delete'));
  const tag = refActionModel({ name: 'v1', type: 'tag' }, { currentBranch: 'main' });
  assert.ok(labels(tag).includes('Push Tag'));
  assert.equal(tag[0].action, 'ideagittool.tag.checkout');
  // A branch checked out in another worktree; synchronous control hides worktree actions.
  assert.equal(refActionModel({ name: 'dev', type: 'local' }, { currentBranch: 'main', otherWorktree: true })[1].action, OPEN_WORKTREE);
  assert.ok(!labels(refActionModel({ name: 'dev', type: 'local' }, { currentBranch: 'main', sync: true })).some(l => l.includes('Worktree')));
});

const state = (): BranchesState => ({
  mac: false,
  repos: [
    {
      root: '/r',
      name: 'r',
      branch: 'pgs/prompt_opt',
      operation: 'none',
      recent: ['dev'],
      refs: [
        { name: 'pgs/prompt_opt', fullName: 'refs/heads/pgs/prompt_opt', type: 'local', current: true },
        { name: 'pgs/antispam', fullName: 'refs/heads/pgs/antispam', type: 'local' },
        { name: 'dev', fullName: 'refs/heads/dev', type: 'local', favorite: true },
        { name: 'origin/dev', fullName: 'refs/remotes/origin/dev', type: 'remote', remote: 'origin' },
        { name: 'v1', fullName: 'refs/tags/v1', type: 'tag' },
      ],
    },
  ],
  sync: false,
  common: [],
  top: topActionModel(['none'], false),
  settings: { groupByDirectory: true, groupByRepository: true, showRecent: true, showTags: true, searchActions: true, syncControl: true },
  fetching: false,
});

test('tree: sections, folders by directory, current branch folder expanded', () => {
  const rows = buildBranchRows(state(), { query: '', expanded: {} });
  const text = rows.map(r => (r.kind === 'branch' ? `${'  '.repeat(r.depth)}${r.label}` : r.kind === 'separator' ? '—' : 'label' in r ? `${'depth' in r ? '  '.repeat(r.depth) : ''}${r.label}` : r.item.label));
  assert.deepEqual(text, [
    'Update Project…',
    'Commit…',
    'Push…',
    '—',
    'New Branch…',
    'Checkout Tag or Revision…',
    '—',
    'Recent',
    '  dev',
    'Local',
    '  pgs',
    '    prompt_opt',
    '    antispam',
    '  dev',
    'Remote',
    '  origin',
    '    dev',
    'Tags',
    '  v1',
  ]);
});

test('tree: speed search filters branches and actions and marks matches', () => {
  assert.deepEqual(matchText('antispam', 'anti'), [0, 1, 2, 3]);
  assert.deepEqual(matchText('prompt_opt', 'pop'), [0, 2, 4]);
  assert.equal(matchText('dev', 'x'), undefined);
  const rows = buildBranchRows(state(), { query: 'anti', expanded: { 'local|dir:pgs': false } });
  const branches = rows.filter(r => r.kind === 'branch');
  assert.equal(branches.length, 1);
  assert.deepEqual(branches[0].kind === 'branch' && branches[0].match, [0, 1, 2, 3]);
  const push = buildBranchRows(state(), { query: 'push', expanded: {} });
  assert.ok(push.some(r => r.kind === 'action' && r.item.label === 'Push…'));
  const none = buildBranchRows(state(), { query: 'zzz', expanded: {} });
  assert.equal(none[none.length - 1].kind, 'empty');
});

test('tree: synchronous control lists common branches, then repositories', () => {
  const s = state();
  s.repos.push({ ...s.repos[0], root: '/q', name: 'q' });
  s.sync = true;
  s.common = [{ name: 'dev', fullName: 'refs/heads/dev', type: 'local' }];
  const rows = buildBranchRows(s, { query: '', expanded: {} });
  const firstBranch = rows.find(r => r.kind === 'branch');
  assert.ok(firstBranch && firstBranch.kind === 'branch' && firstBranch.root === undefined);
  assert.deepEqual(rows.filter(r => r.kind === 'repo').map(r => r.kind === 'repo' && r.label), ['r', 'q']);
});
