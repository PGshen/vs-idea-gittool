import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';

execFileSync(process.execPath, ['scripts/gen-mono-icons.mjs'], { stdio: 'inherit' });

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

// Every directory under src/webview (except lib) with a main.tsx becomes one webview bundle.
const webviewEntries = readdirSync('src/webview', { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'lib' && existsSync(`src/webview/${d.name}/main.tsx`))
  .map(d => ({ in: `src/webview/${d.name}/main.tsx`, out: d.name }));

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info' };

const contexts = [
  await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  }),
  await esbuild.context({
    ...common,
    entryPoints: webviewEntries,
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
  }),
];

if (watch) {
  await Promise.all(contexts.map(c => c.watch()));
} else {
  await Promise.all(contexts.map(c => c.rebuild()));
  await Promise.all(contexts.map(c => c.dispose()));
}
