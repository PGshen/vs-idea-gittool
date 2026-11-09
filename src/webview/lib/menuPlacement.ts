const EDGE = 4;

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Pure placement math for `placeSubmenu` in menu.tsx: beside the parent menu when either side fits, else overlapping it
 * without covering the hovered row (see there). */
export function submenuPlacement(w: number, h: number, row: Rect, parent: Rect, vw: number, vh: number): { left: number; top: number; maxHeight?: number } {
  const roomRight = vw - EDGE - parent.right;
  const roomLeft = parent.left - EDGE;
  if (w <= roomRight || w <= roomLeft) {
    // Beside the parent: the border/padding offset lines the first item up with the parent row.
    const left = w <= roomRight ? parent.right - 1 : parent.left - w + 1;
    let top = row.top - 7;
    if (top + h > vh - EDGE) top = vh - EDGE - h;
    return { left, top: Math.max(EDGE, top) };
  }
  // Overlapping: shift towards the side with more room, and keep clear of the hovered row.
  const left = Math.max(EDGE, roomRight >= roomLeft ? vw - EDGE - w : EDGE);
  const below = vh - EDGE - (row.bottom + 2);
  const above = row.top - 2 - EDGE;
  if (h <= below) return { left, top: row.bottom + 2 };
  if (h <= above) return { left, top: row.top - 2 - h };
  const MIN = 96;
  if (Math.max(below, above) >= MIN) {
    return below >= above ? { left, top: row.bottom + 2, maxHeight: below } : { left, top: EDGE, maxHeight: above };
  }
  // A tiny viewport: no way to stay clear of the row; fit what we can.
  return { left, top: Math.max(EDGE, vh - EDGE - h) };
}
