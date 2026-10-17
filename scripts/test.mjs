// Bundles test/**/*.test.ts (with a vscode stub) and runs them with node:test.
import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`);
rmSync('out-test', { recursive: true, force: true });
await esbuild.build({
  entryPoints: tests,
  outdir: 'out-test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './test/vscode-stub.ts' },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', ...tests.map(t => t.replace(/^test\//, 'out-test/').replace(/\.ts$/, '.js'))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
