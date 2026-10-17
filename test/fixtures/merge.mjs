// Fixture for the merge window: a TypeScript file with non-conflicting changes on both sides,
// an identical change, a simple conflict (magic resolve) and a real conflict.
const base = `import { GraphLayout } from './graph';
import { LogStream } from './logStream';

export interface LogRow {
  hash: string;
  lane: number;
}

const PAGE = 500;

export function loadPage(stream: LogStream, count: number) {
  const rows: LogRow[] = [];
  for (const c of stream.next(count)) {
    rows.push({ hash: c.hash, lane: 0 });
  }
  return rows;
}

export function title(branch: string) {
  return 'Log: ' + branch;
}

export function color(id: number) {
  const r = id * 200 + 30;
  const g = id * 130 + 50;
  return [r, g];
}
`;
const left = base
  .replace("import { LogStream } from './logStream';", "import { LogStream } from './logStream';\nimport { Repository } from './repository';")
  .replace('const PAGE = 500;', 'const PAGE = 1000;')
  .replace("    rows.push({ hash: c.hash, lane: 0 });", "    rows.push({ hash: c.hash, lane: layout.add(c) });")
  .replace("  return 'Log: ' + branch;", "  return `Log: ${branch}`;")
  .replace('  const r = id * 200 + 30;', '  const r = (id * 200 + 30) % 255;');
const right = base
  .replace('  lane: number;\n}', '  lane: number;\n  refs: string[];\n}')
  .replace('const PAGE = 500;', 'const PAGE = 1000;')
  .replace("    rows.push({ hash: c.hash, lane: 0 });", "    rows.push({ hash: c.hash, lane: 0, refs: c.refs });")
  .replace("  return 'Log: ' + branch;", "  return 'Log: ' + branch.trim();")
  .replace('  const g = id * 130 + 50;', '  const g = (id * 130 + 50) % 255;');

export const initial = {
  path: 'src/features/log/model.ts',
  fileName: 'model.ts',
  titles: {
    left: [{ text: 'Changes from ' }, { text: 'master', bold: true }],
    result: [{ text: 'Result' }],
    right: [{ text: 'Changes from ' }, { text: 'feature/log-graph', bold: true }],
  },
  base,
  left,
  right,
  settings: { highlight: 'words', ignore: 'none', syncScroll: true, autoApply: false },
};

export async function handle(method) {
  if (method === 'ask') return true;
  return null;
}

export async function act(page) {
  if (process.env.MERGE_ACT === 'apply') {
    // Apply the left import, then both sides of the "title" conflict (left, then append right).
    await page.click('button[data-i="0"][data-action="apply"][data-side="left"]');
    await page.waitForTimeout(150);
    const title = await page.$$eval('button[data-action="apply"][data-side="left"]', bs => bs.map(b => b.dataset.i));
    const i = title[title.length - 2];
    await page.click(`button[data-i="${i}"][data-action="apply"][data-side="left"]`);
    await page.waitForTimeout(150);
    await page.click(`button[data-i="${i}"][data-action="apply"][data-side="right"]`);
    await page.waitForTimeout(150);
    await page.click('button[data-action="magic"]');
    await page.waitForTimeout(150);
  }
  if (process.env.MERGE_ACT === 'undo') {
    const status = () => page.textContent('.mg-status');
    const before = await status();
    await page.click('button[data-i="0"][data-action="apply"][data-side="left"]');
    await page.click('button.mg-text-action:has-text("All")');
    await page.waitForTimeout(150);
    const mid = await status();
    await page.click('.mg-result .cm-content');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    const afterOne = await status();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    const afterTwo = await status();
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(150);
    console.log('UNDO', JSON.stringify({ before, mid, afterOne, afterTwo, redo: await status() }));
  }
}
