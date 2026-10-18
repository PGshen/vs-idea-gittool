// Create Patch dialog (node scripts/preview.mjs dialog test/fixtures/commit-patch.mjs out.png --size=900x760).
const root = '/home/user/ideagittool';
const files = [
  { root, path: 'README.md', status: 'M', key: 'README.md' },
  { root, path: 'screenshot.png', status: 'M', key: 'screenshot.png' },
  { root, path: 'build/src/org/jetbrains/intellij/build/IdeaGitToolProperties.kt', status: 'M', key: 'build/src/org/jetbrains/intellij/build/IdeaGitToolProperties.kt' },
  { root, path: 'docs/new.md', status: 'A', key: 'docs/new.md' },
];
export const initial = {
  kind: 'commit.createPatch',
  title: 'Create Patch',
  props: {
    files,
    selected: ['README.md', 'screenshot.png', 'docs/new.md'],
    path: '/home/user/ideagittool/Local_Changes.patch',
    basePath: root,
    toClipboard: false,
    reverse: false,
    encoding: 'utf8',
    groupByDirectory: false,
  },
};
export async function handle() {
  return { ok: true };
}
