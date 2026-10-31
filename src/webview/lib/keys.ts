/**
 * Lower-case key of a shortcut, by physical key when Alt is held: on macOS Option turns letters into other
 * characters (Option+M gives `µ`, Option+I is a dead key), so `e.key` cannot be matched against the letter.
 */
export function shortcutKey(e: KeyboardEvent): string {
  return e.altKey && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}
