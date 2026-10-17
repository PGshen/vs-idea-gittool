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

const many = n => Array.from({ length: n }, (_, i) => `// unchanged line ${i + 1}`).join('\n') + '\n';

export const initial = {
  path: 'src/features/log/model.ts',
  fileName: 'model.ts',
  titles: {
    left: [{ text: 'Changes from ' }, { text: 'master', bold: true }],
    result: [{ text: 'Result' }],
    right: [{ text: 'Changes from ' }, { text: 'feature/log-graph', bold: true }],
  },
  base: base + many(20),
  left: left + many(20),
  right: right + many(20),
  settings: { highlight: 'words', ignore: 'none', syncScroll: true, autoApply: false, collapseUnchanged: process.env.MERGE_COLLAPSE === '1' },
  contextLines: 4,
  iterative: true,
};

export async function handle(method, params) {
  if (method === 'ask') return true;
  if (method === 'finish' || method === 'progress') console.log(method.toUpperCase(), JSON.stringify({ result: params.result, states: params.states.length }));
  return null;
}

const op = (page, sel) => page.dispatchEvent(sel, 'mousedown', { button: 0 });

export async function act(page) {
  const act = process.env.MERGE_ACT;
  if (act === 'apply') {
    // Apply the left import, then both sides of the "title" conflict (left, then append right), then magic.
    await op(page, '.mg-left .mg-op[data-i="0"][data-action="apply"]');
    await page.waitForTimeout(150);
    const ids = await page.$$eval('.mg-left .mg-op[data-action="apply"]', bs => bs.map(b => b.dataset.i));
    const i = ids[ids.length - 2];
    await op(page, `.mg-left .mg-op[data-i="${i}"][data-action="apply"]`);
    await page.waitForTimeout(150);
    await op(page, `.mg-right .mg-op[data-i="${i}"][data-action="apply"]`);
    await page.waitForTimeout(150);
    await op(page, '.mg-result .mg-op[data-action="resolve"]');
    await page.waitForTimeout(150);
    console.log('STATUS', await page.textContent('.mg-status'));
  }
  if (act === 'menu') {
    const line = await page.$('.mg-result .cm-line:nth-child(12)');
    const box = await line.boundingBox();
    await page.mouse.click(box.x + 40, box.y + 5, { button: 'right' });
  }
  if (act === 'edit') {
    // Typing in the "color" conflict: the change range grows with the edit and can no longer be resolved by magic.
    const magic = () => page.$$eval('.mg-result .mg-op[data-action="resolve"]', l => l.length);
    const before = await magic();
    await page.click('.mg-result .cm-line:nth-child(24)');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const b = 0;');
    await page.waitForTimeout(150);
    console.log('EDIT', JSON.stringify({ before, after: await magic(), status: await page.textContent('.mg-status') }));
  }
  if (act === 'undo') {
    const status = () => page.textContent('.mg-status');
    const before = await status();
    await op(page, '.mg-left .mg-op[data-i="0"][data-action="apply"]');
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
