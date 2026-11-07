import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

const file = ts.createSourceFile('commitTab.tsx', readFileSync('src/webview/commit/commitTab.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let entries: ts.NodeArray<ts.Expression> | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'entries.push' && node.arguments[0]?.getText(file) === 'revertResolved') {
    entries = node.arguments;
  }
  ts.forEachChild(node, visit);
}
visit(file);

function property(node: ts.Node, name: string): ts.Expression | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const prop = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === name);
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}

test('Copy Path/Reference is the last menu group, separated from primary actions', () => {
  assert.ok(entries);
  const last = entries[entries.length - 1];
  assert.equal(property(last, 'label')?.getText(file), "t('Copy Path/Reference…')");
  assert.equal(property(entries[entries.length - 2], 'separator')?.kind, ts.SyntaxKind.TrueKeyword);
  assert.equal(entries.filter(e => property(e, 'label')?.getText(file) === "t('Copy Path/Reference…')").length, 1);
});

test('moving the menu preserves all copy actions and keyboard hints', () => {
  assert.ok(entries);
  const last = entries[entries.length - 1];
  assert.equal(property(last, 'disabled')?.getText(file), '!files.length');
  const children = property(last, 'children');
  assert.ok(children && ts.isArrayLiteralExpression(children));
  const actions = children.elements.filter(e => property(e, 'action'));
  assert.equal(actions.length, 6);
  for (const kind of ['absolute', 'name', 'lineNumber', 'contentRoot', 'repo', 'reference']) {
    assert.ok(actions.some(e => property(e, 'action')?.getText(file).includes(`kind: '${kind}'`)));
  }
  assert.equal(property(actions[0], 'shortcut')?.getText(file), "'Ctrl+Shift+C'");
  assert.equal(property(actions[5], 'shortcut')?.getText(file), "'Ctrl+Alt+Shift+C'");
});
