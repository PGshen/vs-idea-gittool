// E2E: inline blame after the caret line, like IntelliJ ("author, date, time • subject").
export async function run({ window, shot, command, sleep }) {
  await sleep(4000);
  await command('Go to File');
  await window.keyboard.type('file2.ts');
  await sleep(600);
  await window.keyboard.press('Enter');
  await sleep(2500);
  await shot('inline-blame');
  const text = await window.evaluate(() => {
    for (const el of document.querySelectorAll('.view-lines span')) {
      const after = getComputedStyle(el, '::after').content;
      if (after && after.includes('•')) return after;
    }
    return '';
  });
  console.log('INLINE', text);
  if (!/detachhead, .* • /.test(text)) throw new Error('no inline blame on the caret line');
  console.log('E2E INLINE BLAME OK');
}
