// Renders one ops dialog chosen with the DIALOG environment variable.
const kind = process.env.DIALOG ?? 'ops.reset';
const props = {
  'ops.reset': { commits: [{ hash: 'c1c9c29a00000000000000000000000000000000', subject: 'fixes from merge', author: 'detachhead', repo: 'ideagittool' }], branch: 'master' },
  'ops.newBranch': { title: 'Create New Branch', okLabel: 'Create', initial: 'feature/foo', mode: 'create', checkout: true, showCheckout: true, showOverwrite: true, locals: ['master', 'feature/foo'], remotes: ['origin/master'] },
  'ops.update': { method: 'merge', saveChanges: 'stash', repos: ['ideagittool'], canReset: true },
  'ops.newWorktree': { repos: [{ root: '/home/user/ideagittool', name: 'ideagittool', current: 'master', refs: [{ name: 'master', type: 'local' }, { name: 'feature/log-graph', type: 'local', worktree: '/home/user/ideagittool-log-graph' }, { name: 'origin/master', type: 'remote' }], tags: ['v1.0'] }], root: '/home/user/ideagittool', ref: 'master', parent: '/home/user' },
  'ops.rebase': { repos: [{ root: '/r', name: 'ideagittool', branch: 'master' }], root: '/r', refs: { '/r': [{ value: 'origin/master', icon: 'general/vcs', group: 'Remote' }] }, locals: {}, initialUpstream: 'origin/master', initialOptions: ['interactive', 'rebase-merges'] },
  'ops.pull': { repos: [{ root: '/r', name: 'ideagittool', branch: 'master' }], root: '/r', remotes: { '/r': ['origin', 'upstream'] }, remoteBranches: { '/r': { origin: ['master', 'dev'] } }, defaultRemote: { '/r': 'origin' }, defaultBranch: { '/r': 'master' }, options: ['rebase'] },
  'ops.tag': { root: '/r', repoName: 'ideagittool', currentBranch: 'master', tags: ['v1.0'] },
  'ops.remotes': { repos: [{ root: '/r', name: 'ideagittool' }], remotes: [{ root: '/r', repo: 'ideagittool', name: 'origin', url: 'https://github.com/detachhead/rebased.git' }, { root: '/r', repo: 'ideagittool', name: 'upstream', url: 'https://github.com/JetBrains/intellij-community.git' }] },
  'ops.clone': { parent: '/home/user' },
  'ops.smartOperation': { operation: 'checkout', files: ['src/file1.ts', 'README.md'], untracked: false },
  'ops.pushRejected': { branch: 'master', hasMerges: false },
  'ops.commitMessage': { title: 'Edit Commit Message', message: 'fixes from merge\n\nlonger description', okLabel: 'OK' },
}[kind];
export const initial = { kind, title: kind, props };
export async function handle() {
  return { ok: true };
}
