// Renders a webview bundle in Chromium with a mocked VS Code API and saves a screenshot.
// Usage: node scripts/preview.mjs <bundle> <fixture.mjs> <out.png> [--light] [--size=1400x900] [--actions=actions.mjs]
// The fixture exports `initial` (boot.initial) and `handle(method, params)` (RPC answers),
// and optionally `events`: [[name, data], ...] sent after load, and `act(page)` to interact before the screenshot.
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const [bundle, fixturePath, out] = process.argv.slice(2);
const light = process.argv.includes('--light');
const sizeArg = process.argv.find(a => a.startsWith('--size='));
const [width, height] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [1400, 900];
const fixture = await import(pathToFileURL(resolve(fixturePath)).href);
const root = resolve('.');
const boot = {
  iconsBase: pathToFileURL(resolve('media/icons')).href,
  themeClass: light ? 'ij-light' : 'ij-dark',
  dark: !light,
  initial: typeof fixture.initial === 'function' ? fixture.initial() : fixture.initial,
};
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(resolve(`dist/webview/${bundle}.css`)).href}">
<script>
  window.__calls = [];
  window.acquireVsCodeApi = () => ({
    postMessage(m) { window.__calls.push(m); window.__rpc(m).then(r => window.postMessage(r, '*')); },
    getState() { return window.__state; },
    setState(s) { window.__state = s; },
  });
</script></head>
<body class="${boot.themeClass}"><div id="root"></div>
<script type="application/json" id="boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script src="${pathToFileURL(resolve(`dist/webview/${bundle}.js`)).href}"></script>
</body></html>`;
const dir = mkdtempSync(resolve(tmpdir(), 'rebased-preview-'));
writeFileSync(`${dir}/index.html`, html);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.exposeFunction('__rpc', async m => {
  try {
    const result = await fixture.handle(m.method, m.params);
    return { type: 'res', id: m.id, result: result ?? null };
  } catch (e) {
    return { type: 'res', id: m.id, error: String(e?.message ?? e) };
  }
});
await page.goto(pathToFileURL(`${dir}/index.html`).href);
await page.waitForTimeout(300);
for (const [name, data] of fixture.events ?? []) {
  await page.evaluate(([n, d]) => window.postMessage({ type: 'evt', name: n, data: d }, '*'), [name, data]);
}
await page.waitForTimeout(300);
if (fixture.act) await fixture.act(page);
await page.waitForTimeout(200);
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
