import { formatHintFor, formatShortcutFor } from '../../shared/shortcutText';

/**
 * Lower-case key of a shortcut, by physical key when Alt is held: on macOS Option turns letters into other
 * characters (Option+M gives `µ`, Option+I is a dead key), so `e.key` cannot be matched against the letter.
 */
export function shortcutKey(e: KeyboardEvent): string {
  return e.altKey && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}

/** True on macOS (navigator.platform is deprecated but still reliable in Chromium webviews). */
export const isMac = navigator.platform.startsWith('Mac');

/** Shortcut hint as IntelliJ shows it on this platform: "⌥⌘A" on macOS, "Ctrl+Alt+A" elsewhere. */
export function formatShortcut(shortcut: string): string {
  return formatShortcutFor(shortcut, isMac);
}

/** Rewrites the "Ctrl+" combos inside sentence texts ("Press Ctrl+Enter…") for this platform. */
export function formatHint(text: string): string {
  return formatHintFor(text, isMac);
}
