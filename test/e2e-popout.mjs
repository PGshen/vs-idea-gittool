// E2E: ideagittool.dialogs.openInNewWindow opens dialogs in their own window, which closes with the dialog.
export const settings = { 'ideagittool.dialogs.openInNewWindow': true };

export async function run({ app, window, shot, command, sleep }) {
  await sleep(4000);
  const before = app.windows().length;
  await command('IdeaGitTool: New Branch…');
  await sleep(3000);
  const wins = app.windows();
  console.log('windows', before, '->', wins.length);
  if (wins.length !== before + 1) throw new Error('dialog did not open in a new window');
  const dlg = wins.find(w => w !== window);
  await dlg.screenshot({ path: `${process.env.SHOTS}/popout-dialog.png` });
  await shot('popout-main');
  // Cancel with Escape inside the dialog webview.
  for (const f of dlg.frames()) {
    const el = await f.$('.dialog').catch(() => null);
    if (el) {
      await f.press('.dialog', 'Escape');
      break;
    }
  }
  await sleep(2500);
  console.log('windows after cancel', app.windows().length);
  if (app.windows().length !== before) throw new Error('dialog window did not close');
  console.log('E2E POPOUT OK');
}
