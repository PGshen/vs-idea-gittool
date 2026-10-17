import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphLayout, visualizeRow } from '../src/git/graph';
import { EMPTY_FILTERS, filtersForRepo } from '../src/features/log/filters';
import { LogModel, MergedStream } from '../src/features/log/model';
import { parseUnifiedDiff } from '../src/features/log/fileDiff';
import { Repository } from '../src/git/repository';
import { alignHunks, innerRange } from '../src/webview/log/diffAlign';
import type { Commit } from '../src/shared/types';

/** X (side branch tip) -> P spans 40 rows; M1..M39 is the main line ending in P. */
function longEdgeGraph() {
  const g = new GraphLayout();
  const rows = [g.add('X', ['P'])];
  for (let i = 1; i <= 39; i++) rows.push(g.add(`M${i}`, [i === 39 ? 'P' : `M${i + 1}`]));
  rows.push(g.add('P', []));
  return { g, rows };
}

test('long edges are cut in the middle with arrows and free their lane', () => {
  const { g, rows } = longEdgeGraph();
  const v = rows.map((r, i) => visualizeRow(r, i, g.segments, false));
  // Row 1: stub below X with an arrow pointing down (to the parent).
  const down = v[1].edges.find(e => e.arrow === 'down');
  assert.ok(down, 'arrow down next to the child');
  assert.equal(down!.jump, 'P');
  // Middle rows: only the main line is drawn, in lane 0, and the graph is one lane wide.
  for (let i = 3; i < 37; i++) {
    assert.equal(v[i].edges.length, 2, `row ${i}`);
    assert.equal(v[i].width, 1, `row ${i} width`);
  }
  // Row 39: stub above P with an arrow pointing up (to the child).
  const up = v[39].edges.find(e => e.arrow === 'up');
  assert.ok(up, 'arrow up next to the parent');
  assert.equal(up!.jump, 'X');
});

test('with Long Edges shown the edge is drawn fully', () => {
  const { g, rows } = longEdgeGraph();
  const v = rows.map((r, i) => visualizeRow(r, i, g.segments, true));
  for (let i = 2; i < 38; i++) assert.equal(v[i].width, 2, `row ${i}`);
  // Arrows mark the ends of edges longer than 30 rows.
  assert.ok(v[1].edges.some(e => e.arrow === 'down'));
});

test('short edges are not changed', () => {
  const g = new GraphLayout();
  const raw = [g.add('a', ['c']), g.add('b', ['c']), g.add('c', [])];
  const v = raw.map((r, i) => visualizeRow(r, i, g.segments, false));
  assert.deepEqual(
    v.map(r => r.edges.length),
    raw.map(r => r.edges.length),
  );
});

test('filters for one repository of a multi-root log', () => {
  const repo = { root: '/w/a', refs: [{ name: 'main', fullName: 'refs/heads/main' }] };
  assert.equal(filtersForRepo({ ...EMPTY_FILTERS, roots: ['/w/b'] }, repo, '/w/a'), undefined);
  assert.equal(filtersForRepo({ ...EMPTY_FILTERS, branches: ['dev'] }, repo, '/w/a'), undefined);
  assert.deepEqual(filtersForRepo({ ...EMPTY_FILTERS, branches: ['dev', 'main'] }, repo, '/w/a')!.branches, ['main']);
  assert.deepEqual(filtersForRepo({ ...EMPTY_FILTERS, paths: ['/w/a/src', '/w/b/x'] }, repo, '/w/x')!.paths, ['src']);
  assert.equal(filtersForRepo({ ...EMPTY_FILTERS, paths: ['/w/b/x'] }, repo, '/w/x'), undefined);
});

const commit = (hash: string, commitDate: number): Commit => ({
  hash,
  parents: [],
  subject: hash,
  authorName: 'a',
  authorEmail: 'a',
  authorDate: commitDate,
  committerName: 'a',
  committerEmail: 'a',
  commitDate,
  refs: [],
  root: '/',
});

test('merged stream orders commits of several repositories by date', async () => {
  const src = (list: Commit[]) => {
    let i = 0;
    return { next: async (n: number) => ({ commits: list.slice(i, (i += n)), done: i >= list.length }), dispose() {} };
  };
  const m = new MergedStream([src([commit('a3', 30), commit('a1', 10)]), src([commit('b4', 40), commit('b2', 20)])]);
  const r = await m.next(10);
  assert.deepEqual(
    r.commits.map(c => c.hash),
    ['b4', 'a3', 'b2', 'a1'],
  );
  assert.equal(r.done, true);
});

test('unified diff is aligned side by side', () => {
  const { hunks } = parseUnifiedDiff(['diff --git a/x b/x', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -10,2 +10,3 @@', ' j', '+k', ' l'].join('\n'));
  assert.equal(hunks.length, 2);
  const { items, blocks } = alignHunks(hunks, 11, 12);
  assert.equal(blocks, 2);
  const modified = items.find(i => 'kind' in i && i.kind === 'modified');
  assert.deepEqual(modified, { kind: 'modified', block: 0, left: { n: 2, s: 'b' }, right: { n: 2, s: 'B' } });
  assert.ok(items.some(i => 'gap' in i && i.gap === 6), 'unchanged lines 4..9 are collapsed');
  assert.deepEqual(innerRange('let x = 1;', 'let x = 2;'), [8, 9, 8, 9]);
});

test('collapse linear branches hides the middle of linear fragments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rebased-collapse-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
  const sh = (c: string) => execSync(c, { cwd: dir, env, encoding: 'utf8' });
  sh('git init -q -b main');
  let n = 0;
  const commit = (msg: string) => {
    writeFileSync(join(dir, `f${n++}.txt`), msg);
    sh(`git add -A && git commit -qm "${msg}"`);
  };
  commit('base');
  sh('git checkout -qb side');
  for (let i = 1; i <= 5; i++) commit(`side ${i}`);
  sh('git checkout -q main');
  commit('main 1');
  sh('git merge -q --no-ff side -m merge');
  const repo = new Repository(dir, join(dir, '.git'), join(dir, '.git'));
  await repo.refresh();
  const model = new LogModel([repo]);
  await model.reset(EMPTY_FILTERS, { sort: 'topo', firstParent: false, collapseLinear: true });
  const subjects = model.rows.map(r => r.commit.subject);
  assert.ok(subjects.includes('side 5') && subjects.includes('side 1'), 'ends of the fragment stay visible');
  assert.ok(!subjects.includes('side 3'), 'middle of the fragment is hidden');
  // side 5 carries the branch reference, so the fragment is side 4 .. side 1: side 3 and side 2 are hidden.
  assert.equal(model.hiddenCount, 2);
  assert.ok(model.isHidden(sh('git rev-parse side~2').trim()));
  await model.reset(EMPTY_FILTERS, { sort: 'topo', firstParent: false });
  assert.equal(model.rows.length, 8);
  model.dispose();
  repo.dispose();
});
