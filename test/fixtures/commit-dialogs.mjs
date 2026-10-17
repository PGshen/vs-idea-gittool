// Dialog previews: KIND=commit.rollback|commit.conflicts|commit.unstash|commit.stash|commit.shelve|commit.changelist
const root = '/home/user/rebased';
const files = [
  { root, path: 'README.md', status: 'M' },
  { root, path: 'src/added.ts', status: 'A' },
  { root, path: 'src/old/gone.ts', status: 'D' },
];
const repos = [{ root, name: 'rebased', branch: 'master' }];
const stashes = [
  { index: 0, ref: 'stash@{0}', hash: 'a'.repeat(40), message: 'fix zizmor errors', branch: 'master', date: 0 },
  { index: 1, ref: 'stash@{1}', hash: 'b'.repeat(40), message: 'try new toolbar', branch: 'feature/ui', date: 0 },
];
const row = (path, kind, yours = 'Modified', theirs = 'Modified', badge, reviewed = false) => ({
  key: path,
  root,
  repoName: 'rebased',
  path,
  kind,
  yours,
  theirs,
  badge,
  resolved: !!badge && badge.resolved === badge.total,
  mergeable: yours === 'Modified' && theirs === 'Modified',
  reviewed,
});
const props = {
  'commit.rollback': { files, selected: files.map(f => `${f.root}\u0000${f.path}`), groupByDirectory: true },
  'commit.shelve': { files, selected: [`${root}\u0000README.md`], name: 'WIP', groupByDirectory: false },
  'commit.changelist': { mode: 'new', name: '', comment: '', makeActive: false, existing: ['Changes'] },
  'commit.stash': { repos, root },
  'commit.unstash': { repos, root, stashes },
  'commit.conflicts': {
    rows: [
      row('src/graph.ts', 'both modified', 'Modified', 'Modified', { resolved: 2, total: 5 }),
      row('src/logStream.ts', 'both modified', 'Modified', 'Modified', { resolved: 0, total: 3 }),
      row('src/colors.ts', 'deleted by them', 'Modified', 'Deleted'),
      row('README.md', 'both modified', 'Modified', 'Modified', { resolved: 4, total: 4 }, true),
    ],
    text: 'Merging branch feature/log-graph into branch master',
    yours: 'Yours (master)',
    theirs: 'Theirs (feature/log-graph)',
    showResolvedGroup: true,
    status: '3 conflicts resolved. 6 conflicts in 2 files still require attention',
    allResolvedAndReviewed: false,
    canFinish: false,
    canResolveAutomatically: true,
    busy: false,
  },
};
const kind = process.env.KIND ?? 'commit.rollback';
export const initial = { kind, title: kind, props: props[kind] };
export async function handle() {
  return { ok: true };
}
