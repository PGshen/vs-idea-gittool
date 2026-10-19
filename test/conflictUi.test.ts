import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictUiHost, ConflictUiSettings, HandleConflicts } from '../src/features/commit/conflictEditor';

/** In-memory settings: `values['merge-conflict.codeLens.enabled'] = { globalValue, workspaceValue }`. */
function host(answer: 'yes' | 'no' | undefined, mode: HandleConflicts = 'ask', values: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {}) {
  const writes: string[] = [];
  let asked = false;
  let questions = 0;
  let saved: Record<string, { global?: unknown; workspace?: unknown }> = {};
  const h: ConflictUiHost & { writes: string[]; questions: () => number; mode: () => HandleConflicts; values: typeof values } = {
    writes,
    values,
    questions: () => questions,
    mode: () => mode,
    inspect: (s, k) => values[`${s}.${k}`] ?? {},
    update: async (s, k, v, t) => {
      writes.push(`${t} ${s}.${k}=${v}`);
      const e = (values[`${s}.${k}`] ??= {});
      if (t === 'global') e.globalValue = v;
      else e.workspaceValue = v;
    },
    handleConflicts: () => mode,
    setHandleConflicts: async v => {
      mode = v;
    },
    asked: () => asked,
    setAsked: async () => {
      asked = true;
    },
    saved: () => saved,
    setSaved: async v => {
      saved = v;
    },
    askUser: async () => {
      questions++;
      return answer;
    },
  };
  return h;
}

test('built-in conflict UI settings are not changed without consent', async () => {
  for (const answer of ['no', undefined] as const) {
    const h = host(answer);
    assert.equal(await new ConflictUiSettings(h).onConflicts(), false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.questions(), 1);
  }
  const never = host('yes', 'never');
  await new ConflictUiSettings(never).onConflicts();
  assert.deepEqual(never.writes, []);
  assert.equal(never.questions(), 0);
});

test('the question is asked once per workspace; "no" is remembered as never', async () => {
  const h = host(undefined);
  const s = new ConflictUiSettings(h);
  await s.onConflicts();
  await s.onConflicts();
  assert.equal(h.questions(), 1);
  const no = host('no');
  await new ConflictUiSettings(no).onConflicts();
  assert.equal(no.mode(), 'never');
});

test('agreeing turns the built-in conflict UI off and remembers "always"', async () => {
  const h = host('yes', 'ask', { 'git.mergeEditor': { globalValue: true } });
  assert.equal(await new ConflictUiSettings(h).onConflicts(), true);
  assert.deepEqual(h.writes, ['global merge-conflict.codeLens.enabled=false', 'global merge-conflict.decorators.enabled=false', 'global git.mergeEditor=false']);
  assert.equal(h.mode(), 'always');
});

test('git.mergeEditor at its default (off) is left alone; workspace values are turned off too', async () => {
  const h = host('yes', 'ask', { 'merge-conflict.decorators.enabled': { workspaceValue: true } });
  await new ConflictUiSettings(h).onConflicts();
  assert.deepEqual(h.writes, ['global merge-conflict.codeLens.enabled=false', 'workspace merge-conflict.decorators.enabled=false', 'global merge-conflict.decorators.enabled=false']);
});

test('restore brings back the values from before', async () => {
  const h = host('yes', 'ask', { 'git.mergeEditor': { globalValue: true }, 'merge-conflict.decorators.enabled': { workspaceValue: true } });
  const s = new ConflictUiSettings(h);
  await s.onConflicts();
  // Applying again does not overwrite the remembered values.
  await s.apply();
  h.writes.length = 0;
  await s.restore();
  assert.deepEqual(h.writes, [
    'global merge-conflict.codeLens.enabled=undefined',
    'global merge-conflict.decorators.enabled=undefined',
    'workspace merge-conflict.decorators.enabled=true',
    'global git.mergeEditor=true',
  ]);
  assert.equal(h.mode(), 'never');
});
