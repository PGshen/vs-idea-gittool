const now = Math.floor(Date.now() / 1000);
const subjects = ['add build scripts', 'draw graph lanes', 'graph colors from DefaultColorGenerator', 'fix `test.cmd` command', 'update readme screenshot', 'fixes from merge'];
const commits = subjects.map((s, i) => ({ hash: `${String(i).repeat(8)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, subject: s, body: s, author: 'detachhead', date: now - (6 - i) * 7200 }));
export const initial = { kind: 'ops.interactiveRebase', title: 'Rebasing Commits', props: { root: '/r', commits } };
export async function handle(method) {
  if (method === 'commitChanges') return [{ root: '/r', path: 'src/graph/Lanes.kt', status: 'M' }, { root: '/r', path: 'README.md', status: 'A' }];
  return null;
}
export async function act(page) {
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('d');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('f');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('e');
}
