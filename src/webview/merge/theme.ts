import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Editor look of IntelliJ New UI: JetBrains Mono 13px, editor colors of expUI_dark / expUI_light,
 * syntax colors of the Dark / Light schemes. Colors come from CSS variables set in merge.css.
 */
export const editorTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--mg-editor-bg)',
    color: 'var(--mg-editor-fg)',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', var(--vscode-editor-font-family), Menlo, Consolas, monospace",
    lineHeight: '20px',
  },
  '.cm-content': { padding: '0', caretColor: 'var(--mg-caret)' },
  '.cm-line': { padding: '0 8px 0 6px' },
  '.cm-gutters': {
    backgroundColor: 'var(--mg-editor-bg)',
    color: 'var(--mg-line-number)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
  '.cm-activeLine': { backgroundColor: 'var(--mg-caret-row)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--mg-line-number-active)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--mg-caret)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--mg-selection) !important' },
});

export function syntaxTheme(dark: boolean): Extension {
  const c = dark
    ? { kw: '#CF8E6D', str: '#6AAB73', num: '#2AACB8', com: '#7A7E85', fn: '#56A8F5', type: '#BCBEC4', prop: '#C77DBB', meta: '#B3AE60', tag: '#D5B778', attr: '#BABABA', const: '#C77DBB' }
    : { kw: '#0033B3', str: '#067D17', num: '#1750EB', com: '#8C8C8C', fn: '#00627A', type: '#000000', prop: '#871094', meta: '#9E880D', tag: '#0033B3', attr: '#174AD4', const: '#871094' };
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.bool, t.null], color: c.kw },
      { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c.str },
      { tag: [t.number, t.integer, t.float], color: c.num },
      { tag: [t.comment, t.lineComment, t.blockComment], color: c.com, fontStyle: 'italic' },
      { tag: t.docComment, color: dark ? '#5F826B' : '#8C8C8C', fontStyle: 'italic' },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.fn },
      { tag: [t.typeName, t.className, t.namespace], color: c.type },
      { tag: [t.propertyName], color: c.prop },
      { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: c.const },
      { tag: [t.meta, t.annotation, t.processingInstruction], color: c.meta },
      { tag: [t.tagName], color: c.tag },
      { tag: [t.attributeName], color: c.attr },
      { tag: t.heading, color: c.kw, fontWeight: 'bold' },
      { tag: t.link, color: c.str, textDecoration: 'underline' },
      { tag: t.invalid, color: '#F75464' },
    ]),
  );
}
