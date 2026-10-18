// Preview fixture for the log webview: a history resembling the IdeaGitTool screenshot.
import * as esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['src/git/graph.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { GraphLayout } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const root = '/home/user/ideagittool';
const t0 = Date.UTC(2026, 5, 17, 18, 56) / 1000;
let h = 0;
const hash = () => (++h).toString(16).padStart(8, '0') + 'c1c9c29a5b0d4e1f2a3b4c5d6e7f8091'.slice(0, 32);
const spec = [
  ['fix `test.cmd` command', 'detachhead'],
  ['fix zizmor errors', 'detachhead'],
  ['Revert "Revert "IJI-3418 build scripts: Bazel: simplify running build targets by extracting""', 'detachhead'],
  ['Revert "Revert "IJI-3417 installers.cmd/tests.cmd should use Bazel to run""', 'detachhead'],
  ['update android repo', 'detachhead'],
  ['fixes from merge', 'detachhead'],
  ["Merge remote-tracking branch 'origin/262' into merge-262", 'detachhead', 'merge'],
  ['misc monorepo run configurations: add ij light + lsp ui run configuration', 'Dmitry Batkovich', 'side'],
  ['[terminal] IJPL-177936 update jediterm to 3.72', 'Sergey Simonchik', 'side'],
  ['IJPL-246148 LSP: rename LspClientImpl & LspClientManagerImpl - usages in monorepo', 'Tomasz Blachut', 'side'],
  ['[agent-workbench][ai-review]: adjust model and effort on AI Review tab (IJPL-246329)', 'Dmitry Zhuravlev', 'side'],
  ['[agent-workbench][ai-review]: show provider selector on AI Review tab (IJPL-246329)', 'Dmitry Zhuravlev', 'side'],
  ['[kotlin] KTIJ-38640 Use already imported Java class rather than Kotlin alias, if it exists', 'Frederik Haselmeier', 'side'],
  ["Merge `dimonchik0036/kt-master-2026-06-16` into `master`", 'Patronus', 'merge2'],
  ['MRI-4550 [kotlin] Deduplicate debugger tests', 'Dmitrii Gridin', 'side2'],
  ['cleanup LSP: suppress depraction for bridge function', 'Tomasz Blachut', 'side2'],
  ['IJPL-246148 LSP: clarify usages of runningClients in LspClientManagerImpl', 'Tomasz Blachut', 'side2'],
  ['cleanup [inlay-hints]: formatting', 'Vojtech Balik', 'side2'],
  ['PY-89541 typing: error on default of list literal for type parameter', 'Morgan Bartholomew', 'side2'],
  ['test [platform]: improving `VfsEventsTest.testModifiedJar` stability', 'Roman Shevchenko', 'main'],
  ['IJPL-172902 add a terminal into the environment variables dashboard', 'Mihail Buryakov', 'main'],
  ['IJPL-172902 add experimental mode of capturing environment variables, via shell', 'Mihail Buryakov', 'main'],
];
// Build a DAG: main line with two merges.
const commits = spec.map(([s, a], i) => ({ hash: hash(), subject: s, author: a, i }));
for (let i = 0; i < 200; i++) commits.push({ hash: hash(), subject: `IJPL-${170000 + i} commit number ${i}`, author: ['Mihail Buryakov', 'Tomasz Blachut', 'detachhead'][i % 3], i: commits.length });
const H = i => commits[i].hash;
const parents = commits.map((c, i) => (i + 1 < commits.length ? [H(i + 1)] : []));
parents[6] = [H(19), H(7)]; // merge-262: main continues at 19, side branch 7..12
parents[12] = [H(13)];
parents[13] = [H(19), H(14)];
parents[18] = [H(19)];
const refsAt = { 0: ['HEAD', 'refs/heads/master', 'refs/remotes/origin/master'], 4: ['refs/tags/v262.1'], 7: ['refs/remotes/origin/262'], 19: ['refs/heads/dont-optimize'] };
const layout = new GraphLayout();
const rows = commits.map((c, i) => ({
  h: c.hash,
  p: parents[i],
  s: c.subject,
  an: c.author,
  ae: `${c.author.split(' ')[0].toLowerCase()}@users.noreply.github.com`,
  at: t0 - i * 2400,
  cn: c.author === 'Patronus' ? 'TeamCity' : c.author,
  ct: t0 - i * 2400,
  refs: refsAt[i] ?? [],
  g: layout.add(c.hash, parents[i]),
  b: true,
}));

const refs = [
  { fullName: 'refs/heads/master', name: 'master', type: 'local', hash: H(0), current: true, upstream: 'origin/master', ahead: 2, behind: 0, favorite: true },
  { fullName: 'refs/heads/dont-optimize', name: 'dont-optimize', type: 'local', hash: H(19) },
  { fullName: 'refs/heads/feature/log-graph', name: 'feature/log-graph', type: 'local', hash: H(30) },
  { fullName: 'refs/heads/feature/shelf', name: 'feature/shelf', type: 'local', hash: H(40) },
  { fullName: 'refs/remotes/origin/master', name: 'origin/master', type: 'remote', remote: 'origin', hash: H(0) },
  { fullName: 'refs/remotes/origin/262', name: 'origin/262', type: 'remote', remote: 'origin', hash: H(7) },
  { fullName: 'refs/tags/v262.1', name: 'v262.1', type: 'tag', hash: H(4) },
];

export const initial = {
  tabId: 'log1',
  mode: 'log',
  title: 'Log: HEAD',
  repos: [{ root, name: 'ideagittool' }],
  root,
  refs,
  head: { branch: 'master', hash: H(0), detached: false, operation: 'none' },
  filters: { branches: ['HEAD'], users: [], paths: [], text: '', regex: false, matchCase: false },
  options: { sort: 'topo', firstParent: false },
  settings: {
    showBranches: false,
    columns: { author: true, date: true, hash: false },
    columnWidths: { author: 120, date: 130, hash: 80 },
    compactRefs: true,
    showTagNames: false,
    preferCommitDate: false,
    refsOnLeft: false,
    showDetails: true,
    showRootNames: false,
    highlightMyCommits: false,
    highlightMergeCommits: false,
    highlightCurrentBranch: true,
    changesGroupByDirectory: true,
    showOnlyAffectedChanges: false,
    branchesGroupByDirectory: true,
    branchesShowTags: false,
    branchesSingleClickFilter: false,
    branchesSingleClickNavigate: true,
    rightWidth: 345,
    branchesWidth: 220,
  },
  me: { name: 'detachhead', email: 'detachhead@users.noreply.github.com' },
  select: H(5),
};

const files = [
  '.github/actions/upload_ide/action.yml',
  '.github/workflows/ide_build_and_upload.yml',
  'build/idea-community-images/linux/icon_ideagittool_128.png',
  'build/idea-community-images/linux/product_128.png',
  'build/idea-community-images/mac/product.icns',
  'build/idea-community-images/mac/ideagittool.icns',
  'build/idea-community-images/win/product.ico',
  'build/idea-community-images/win/ideagittool.ico',
  'build/src/org/jetbrains/intellij/build/IdeaGitToolProperties.kt',
  'images/resources/META-INF/plugin.xml',
  'platform/a/README.md',
  'platform/b/Main.java',
  'platform/c/old.txt',
];

export async function handle(method, params) {
  switch (method) {
    case 'rows': {
      const { start, count } = params;
      return { start, rows: rows.slice(start, start + count), total: rows.length, done: true };
    }
    case 'details': {
      const c = commits.find(x => x.hash === params.hashes[0]);
      return {
        details: [
          {
            ...rows[c.i],
            hash: c.hash,
            parents: rows[c.i].p,
            subject: c.subject,
            authorName: c.author,
            authorEmail: 'detachhead@users.noreply.github.com',
            authorDate: rows[c.i].at,
            committerName: c.author,
            committerEmail: '',
            commitDate: rows[c.i].at + 4 * 86400,
            refs: rows[c.i].refs,
            root,
            body: c.subject,
          },
        ],
        changes: files.map((p, i) => ({ root, path: p, status: i === 12 ? 'D' : i === 2 || i === 5 || i === 7 ? 'A' : 'M' })),
        left: H(c.i + 1),
        right: c.hash,
      };
    }
    case 'containing':
      return ['HEAD', 'master', 'dont-optimize', 'origin/master', 'origin/262', 'feature/a', 'feature/b', 'feature/c', 'x', 'y', 'z', 'w'];
    case 'contextInfo':
      return { inHead: true, pushed: false, hasMerges: false, isHead: false, refs: [], operation: 'none', webUrl: 'https://github.com/detachhead/rebased/commit/x' };
    case 'authors':
      return ['detachhead <detachhead@users.noreply.github.com>', 'Tomasz Blachut <t@x>'];
    default:
      return null;
  }
}

export async function act(page) {
  if (process.env.ACT === 'menu') {
    await page.click('.log-row.selected', { button: 'right' });
    await page.waitForTimeout(300);
  }
  if (process.env.ACT === 'branches') {
    await page.click('.stripe-toggle');
    await page.waitForTimeout(300);
  }
}
