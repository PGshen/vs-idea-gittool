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
// Tests compare file contents byte for byte, so override core.autocrlf (true by default in Git for Windows) for every git they run.
const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
const r = spawnSync(process.execPath, ['--test', ...tests.map(t => t.replace(/^test\//, 'out-test/').replace(/\.ts$/, '.js'))], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
