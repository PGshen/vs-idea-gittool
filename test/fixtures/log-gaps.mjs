// Preview fixture for the newer log features: multi-root log with root colors, long edges with arrows,
// GPG Signature column, Not Cherry-Picked Commits dimming and the diff preview.
// Variants via env LAYOUT: bottom (default) | right | unified | branches | branches-merged (without Group by Repository).
import * as esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['src/git/graph.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { GraphLayout, visualizeRow } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const layoutVariant = process.env.LAYOUT ?? 'bottom';
const branchesPane = layoutVariant.startsWith('branches');
const roots = ['/work/ideagittool', '/work/intellij-community'];
const t0 = Date.UTC(2026, 5, 17, 18, 56) / 1000;
let n = 0;
const hash = () => (++n).toString(16).padStart(8, '0') + '9f1e2d3c4b5a69788796a5b4c3d2e1f0';

// Repository 0: a side branch whose fork point is 40 commits below (a long edge), plus a main line.
const commits = [];
const add = (subject, author, root, parents) => {
  const c = { hash: hash(), subject, author, root, parents };
  commits.push(c);
  return c;
};
const sideTip = add('[ide] add the IdeaGitTool product icons', 'detachhead', 0, []);
const main = [];
for (let i = 0; i < 45; i++) main.push(add(i === 0 ? 'fix `test.cmd` command' : `IJPL-${180000 + i} platform change ${i}`, ['detachhead', 'Tomasz Blachut', 'Mihail Buryakov'][i % 3], i % 4 === 1 ? 1 : 0, []));
for (let i = 0; i < main.length - 1; i++) main[i].parents = [main[i + 1].hash];
sideTip.parents = [main[40].hash];

const layout = new GraphLayout();
const raw = commits.map(c => layout.add(c.hash, c.parents));
const rows = commits.map((c, i) => ({
  h: c.hash,
  p: c.parents,
  s: c.subject,
  an: c.author,
  ae: `${c.author.split(' ')[0].toLowerCase()}@users.noreply.github.com`,
  at: t0 - i * 2400,
  cn: c.author,
  ct: t0 - i * 2400,
  refs: i === 0 ? ['refs/heads/feature/icons'] : i === 1 ? ['HEAD', 'refs/heads/master', 'refs/remotes/origin/master'] : [],
  g: visualizeRow(raw[i], i, layout.segments, false),
  b: i > 0,
  r: c.root,
}));

const refs = [
  { fullName: 'refs/heads/master', name: 'master', type: 'local', hash: commits[1].hash, current: true, upstream: 'origin/master', favorite: true, root: roots[0] },
  { fullName: 'refs/heads/feature/icons', name: 'feature/icons', type: 'local', hash: commits[0].hash, root: roots[0] },
  { fullName: 'refs/remotes/origin/master', name: 'origin/master', type: 'remote', remote: 'origin', hash: commits[1].hash, root: roots[0] },
  { fullName: 'refs/heads/master', name: 'master', type: 'local', hash: commits[2].hash, current: true, root: roots[1] },
  { fullName: 'refs/heads/kt-master', name: 'kt-master', type: 'local', hash: commits[6].hash, root: roots[1] },
  { fullName: 'refs/remotes/origin/master', name: 'origin/master', type: 'remote', remote: 'origin', hash: commits[2].hash, root: roots[1] },
];

const head = { branch: 'master', hash: commits[1].hash, detached: false, operation: 'none' };
export const initial = {
  tabId: 'log1',
  mode: 'log',
  title: 'Log',
  repos: [
    { root: roots[0], name: 'ideagittool', head, color: 0 },
    { root: roots[1], name: 'intellij-community', head: { branch: 'master', hash: commits[2].hash, detached: false, operation: 'none' }, color: 1 },
  ],
  multi: true,
  root: roots[0],
  refs,
  head,
  filters: { branches: [], users: [], paths: [], text: '', regex: false, matchCase: false },
  options: { sort: 'topo', firstParent: false },
  settings: {
    showBranches: branchesPane,
    columns: { author: true, date: true, hash: false, signature: true },
    columnWidths: { author: 120, date: 130, hash: 80, signature: 28 },
    compactRefs: true,
    showTagNames: false,
    showLongEdges: false,
    preferCommitDate: false,
    refsOnLeft: false,
    showDetails: true,
    showRootNames: branchesPane,
    highlightMyCommits: false,
    highlightMergeCommits: false,
    highlightCurrentBranch: true,
    changesGroupByDirectory: true,
    changesGroupByRepository: true,
    showOnlyAffectedChanges: false,
    showDiffPreview: !branchesPane,
    diffPreviewLocation: layoutVariant === 'right' ? 'right' : 'bottom',
    diffUnified: layoutVariant === 'unified',
    diffCollapseUnchanged: true,
    diffPreviewSize: 330,
    branchesGroupByDirectory: true,
    branchesGroupByRepository: layoutVariant !== 'branches-merged',
    branchesShowTags: false,
    branchesSingleClickFilter: false,
    branchesSingleClickNavigate: true,
    showMyBranches: false,
    rightWidth: 330,
    branchesWidth: 240,
  },
  me: { name: 'detachhead', email: 'detachhead@users.noreply.github.com' },
  select: commits[0].hash,
};

const files = ['build/idea-community-images/linux/icon_ideagittool_128.png', 'build/src/org/jetbrains/intellij/build/IdeaGitToolProperties.kt', 'README.md'];

const hunks = [
  {
    oldStart: 12,
    oldLines: 7,
    newStart: 12,
    newLines: 8,
    lines: [
      { t: ' ', s: 'object IdeaGitToolProperties : JetBrainsProductProperties() {' },
      { t: ' ', s: '  init {' },
      { t: '-', s: '    platformPrefix = "Idea"' },
      { t: '+', s: '    platformPrefix = "IdeaGitTool"' },
      { t: ' ', s: '    applicationInfoModule = "intellij.ideagittool"' },
      { t: '+', s: '    productLayout.productIcons = listOf("ideagittool.svg", "ideagittool_16.svg")' },
      { t: ' ', s: '    scrambleMainJar = false' },
      { t: '-', s: '    useSplash = true' },
      { t: ' ', s: '  }' },
    ],
  },
  {
    oldStart: 40,
    oldLines: 3,
    newStart: 41,
    newLines: 3,
    lines: [
      { t: ' ', s: '  override fun getBaseArtifactName(appInfo: ApplicationInfoProperties, buildNumber: String): String =' },
      { t: '-', s: '    "ideaIC-$buildNumber"' },
      { t: '+', s: '    "ideagittool-$buildNumber"' },
    ],
  },
];

export async function handle(method, params) {
  switch (method) {
    case 'rows': {
      const { start, count } = params;
      const out = rows.slice(start, start + count).map(r => ({ ...r, r: r.r }));
      return { start, rows: out, total: rows.length, done: true, gen: 1 };
    }
    case 'details': {
      const c = commits.find(x => x.hash === params.hashes[0]);
      const i = commits.indexOf(c);
      return {
        details: [
          {
            hash: c.hash,
            parents: c.parents,
            subject: c.subject,
            authorName: c.author,
            authorEmail: 'detachhead@users.noreply.github.com',
            authorDate: rows[i].at,
            committerName: c.author,
            committerEmail: '',
            commitDate: rows[i].at,
            refs: rows[i].refs,
            root: roots[c.root],
            body: c.subject,
            signature: 'G',
            signer: 'detachhead <detachhead@users.noreply.github.com>',
          },
        ],
        changes: files.map((p, k) => ({ root: roots[c.root], path: p, status: k === 0 ? 'A' : 'M' })),
        left: c.parents[0],
        right: c.hash,
      };
    }
    case 'fileDiff':
      return { path: params.change.path, binary: false, hunks, oldTotal: 60, newTotal: 61 };
    case 'signatures':
      return Object.fromEntries(params.map((h, i) => [h, { status: i % 5 === 0 ? 'U' : 'G', signer: 'detachhead' }]));
    case 'containing':
      return ['feature/icons'];
    case 'contextInfo':
      return { inHead: true, pushed: false, hasMerges: false, isHead: false, refs: [], operation: 'none', hasRemoteBranches: true };
    case 'myBranches':
      return [`${roots[0]}\0refs/heads/feature/icons`];
    default:
      return null;
  }
}

export async function act(page) {
  if (branchesPane) {
    await page.waitForTimeout(200);
    await page.waitForTimeout(200);
  }
  if (process.env.ACT === 'changesMenu') {
    await page.click('.right .tree-row >> text=IdeaGitToolProperties.kt', { button: 'right' });
    await page.waitForTimeout(400);
  }
  if (process.env.ACT === 'graphMenu') {
    await page.click('[data-tip="Graph Options"]');
    await page.waitForTimeout(300);
  }
  if (process.env.ACT === 'viewMenu') {
    await page.click('[data-tip="View Options"]');
    await page.waitForTimeout(300);
  }
}
