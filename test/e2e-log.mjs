// E2E: the log opens on startup in the editor; file history and annotate work.
export async function run({ window, shot, command, sleep }) {
  await sleep(4000);
  await shot('log-startup');
  // Click the second commit row inside the log webview.
  const frames = window.frames();
  for (const f of frames) {
    const row = await f.$('.log-row:nth-child(3)').catch(() => null);
    if (row) {
      await row.click();
      await sleep(800);
      await row.click({ button: 'right' });
      await sleep(600);
      break;
    }
  }
  await shot('log-context-menu');
  await window.keyboard.press('Escape');
  await command('IdeaGitTool: Open New Git Log Tab');
  await sleep(1500);
  await shot('log-new-tab');
  await command('Go to File');
  await window.keyboard.type('file1.ts');
  await sleep(500);
  await window.keyboard.press('Enter');
  await sleep(1000);
  await command('IdeaGitTool: Annotate with Git Blame');
  await sleep(1500);
  await shot('annotate');
  await command('IdeaGitTool: Show History');
  await sleep(2500);
  await shot('file-history');
}
