// E2E for Show Diff Preview in the Commit tool window (#35): with the option on, a single click on a file opens its diff
// in the preview editor, the keyboard focus stays in the changes tree, and the arrow keys move the preview along.
// Run: xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/e2e.mjs test/e2e-diff-preview.mjs
export const settings = { 'ideagittool.log.openOnStartup': false };

async function findFrame(window, selector, sleep, tries = 40) {
  for (let i = 0; i < tries; i++) {
    for (const f of window.frames()) {
      try {
        if (await f.$(selector)) return f;
      } catch {
        // detached frame
      }
    }
    await sleep(500);
  }
  throw new Error(`frame with ${selector} not found`);
}

function check(cond, message) {
  if (!cond) throw new Error(message);
  console.log('OK:', message);
}

/** Titles of the editor tabs, with whether each is a preview (italic) tab. */
const tabs = window =>
  window.$$eval('.tabs-container .tab', els => els.map(e => {
    const title = e.getAttribute('aria-label') ?? e.textContent ?? '';
    return { title, preview: title.endsWith(', preview') || e.classList.contains('italic') };
  }));

export async function run({ window, shot, sleep, command }) {
  await command('IdeaGitTool: Commit…');
  const frame = await findFrame(window, '.tw-tabs', sleep);
  await sleep(1500);

  // Off by default: a single click only selects the file.
  await frame.click('.tree-row:visible:has-text("README.md") .label');
  await sleep(1200);
  check(!(await tabs(window)).some(t => t.title.includes('README.md')), 'without Show Diff Preview a single click opens nothing');

  // Turn it on from the ⋮ Options menu.
  await frame.click('.tw-tabs .action-button[aria-label="Options"]', { force: true });
  await sleep(500);
  await frame.click('.menu-item:has-text("Show Diff Preview")', { force: true });
  await sleep(1000);

  // Turning it on previews the file that is already selected.
  let open = await tabs(window);
  await shot('diff-preview-readme');
  check(open.some(t => t.title.includes('README.md') && t.preview), `README.md diff opens in a preview tab (${JSON.stringify(open)})`);

  // A single click on another file replaces the preview.
  await frame.click('.tree-row:visible:has-text("file1.ts") .label');
  await sleep(1500);
  open = await tabs(window);
  check(open.some(t => t.title.includes('file1.ts') && t.preview), 'single click on file1.ts shows its diff');
  check(!open.some(t => t.title.includes('README.md')), 'the preview tab is reused, README.md diff is gone');

  // The focus stayed in the tree: the arrow keys keep stepping through files.
  const before = open.find(t => t.preview)?.title;
  await window.keyboard.press('ArrowUp');
  await sleep(1500);
  open = await tabs(window);
  await shot('diff-preview-arrow');
  const after = open.find(t => t.preview)?.title;
  check(after && after !== before, `arrow key moves the preview (${before} → ${after})`);
  check(open.length === 1, `one editor tab only (${open.length})`);
  console.log('E2E DIFF PREVIEW OK');
}
