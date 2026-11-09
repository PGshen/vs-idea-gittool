/**
 * Platform-aware rendering of keyboard shortcut texts, as IntelliJ shows them: "Ctrl+Shift+K" on
 * Windows/Linux, "⇧⌘K" on macOS.
 */

const GLYPHS: Record<string, string> = { Ctrl: '⌘', Cmd: '⌘', Alt: '⌥', Shift: '⇧' };
const ARROWS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
const ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

/** "Ctrl+Shift+K" → "⇧⌘K" on macOS, unchanged elsewhere; keys outside Ctrl/Alt/Shift/Cmd combos (F-keys, already-glyph texts) pass through. */
export function formatShortcutFor(keys: string, mac: boolean): string {
  if (!mac) return keys;
  // IntelliJ macOS shows the Delete key as ⌫, and keeps ⌃ where the mac binding stays on Control (Ctrl+Space).
  if (keys === 'Delete') return '⌫';
  if (keys === 'Ctrl+Space') return '⌃Space';
  if (!/^(Ctrl|Alt|Shift|Cmd)\+/.test(keys)) return keys;
  const parts = keys.split('+');
  const key = parts.pop()!;
  const mods = parts.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  // On macOS, IntelliJ's ⌘ replaces Ctrl and is printed after ⌥ / ⇧.
  const printed = [...mods.filter(m => m !== 'Ctrl' && m !== 'Cmd'), ...mods.filter(m => m === 'Ctrl' || m === 'Cmd')];
  return printed.map(m => GLYPHS[m] ?? m).join('') + (ARROWS[key] ?? key);
}

/** Rewrites the "Ctrl+X" style combos inside sentence-like texts ("Press Ctrl+Enter…") for macOS, in canonical order. */
export function formatHintFor(text: string, mac: boolean): string {
  if (!mac) return text;
  return text.replace(/(?:(?:Ctrl|Alt|Shift|Cmd)\+)+[\p{L}\p{N}]+/gu, m => formatShortcutFor(m, true));
}

/**
 * True when a Backspace edits a Tree's speed-search text instead of reaching the tab's key handler: tabs that
 * delete their selection on plain ⌫ (macOS) must not see the key while a query is being typed.
 */
export function speedSearchBackspace(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }, search: string): boolean {
  return !!search && e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}
