// Create Patch dialog (node scripts/preview.mjs dialog test/fixtures/commit-patch.mjs out.png --size=900x760).
const root = '/home/user/rebased';
const files = [
  { root, path: 'README.md', status: 'M', key: 'README.md' },
  { root, path: 'screenshot.png', status: 'M', key: 'screenshot.png' },
  { root, path: 'build/src/org/jetbrains/intellij/build/RebasedProperties.kt', status: 'M', key: 'build/src/org/jetbrains/intellij/build/RebasedProperties.kt' },
  { root, path: 'docs/new.md', status: 'A', key: 'docs/new.md' },
];
export const initial = {
  kind: 'commit.createPatch',
  title: 'Create Patch',
  props: {
    files,
    selected: ['README.md', 'screenshot.png', 'docs/new.md'],
    path: '/home/user/rebased/Local_Changes.patch',
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
