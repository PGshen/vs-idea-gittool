const now = Math.floor(Date.now() / 1000);
const commits = [
  { hash: 'c1c9c29a1111111111111111111111111111aaaa', subject: 'fixes from merge', author: 'detachhead', authorEmail: 'detachhead@users.noreply.github.com', date: now - 3600, body: 'fixes from merge\n\nmore details here' },
  { hash: 'b2b2b2b21111111111111111111111111111bbbb', subject: 'update readme screenshot', author: 'detachhead', date: now - 7200 },
  { hash: 'a3a3a3a31111111111111111111111111111cccc', subject: 'fix `test.cmd` command', author: 'detachhead', date: now - 86400 * 2 },
];
export const initial = {
  kind: 'ops.push',
  title: 'Push Commits to ideagittool',
  props: {
    title: 'Push Commits to ideagittool',
    tagsMode: 'none',
    runHooks: true,
    forceAllowed: true,
    repos: [
      { root: '/r', name: 'ideagittool', source: 'master', remote: 'origin', target: 'master', remotes: ['origin', 'upstream'], remoteBranches: { origin: ['master', 'dev'] }, commits, isNew: false, hasUpstream: true, checked: true },
    ],
  },
};
export async function handle(method) {
  if (method === 'commitChanges')
    return [
      { root: '/r', path: 'README.md', status: 'M', hash: 'x' },
      { root: '/r', path: 'screenshot.png', status: 'M', hash: 'x' },
      { root: '/r', path: 'build/src/org/jetbrains/intellij/build/IdeaGitToolProperties.kt', status: 'A', hash: 'x' },
      { root: '/r', path: '.github/workflows/ide_build_and_upload.yml', status: 'D', hash: 'x' },
    ];
  return null;
}
