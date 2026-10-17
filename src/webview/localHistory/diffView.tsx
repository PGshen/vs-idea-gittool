import { useMemo } from 'preact/hooks';
import { diffLines, splitLines } from '../../shared/lineDiff';
import { LhSide } from '../../shared/localHistoryProtocol';

interface Row {
  l?: string;
  r?: string;
  ln?: number;
  rn?: number;
  /** '' equal, 'mod' modified, 'ins' inserted, 'del' deleted. */
  kind: '' | 'mod' | 'ins' | 'del';
  /** First row of a change block, used by the change navigation. */
  start?: boolean;
}

/** Builds aligned rows for the two-side diff, like IntelliJ's side-by-side viewer with filler lines. */
export function buildRows(left: string[], right: string[]): Row[] {
  const rows: Row[] = [];
  const blocks = diffLines(left, right);
  let a = 0;
  let b = 0;
  const equalUntil = (a1: number) => {
    while (a < a1) rows.push({ l: left[a], r: right[b], ln: ++a, rn: ++b, kind: '' });
  };
  for (const bl of blocks) {
    equalUntil(bl.a0);
    const n = Math.max(bl.a1 - bl.a0, bl.b1 - bl.b0);
    const kind = bl.a1 === bl.a0 ? 'ins' : bl.b1 === bl.b0 ? 'del' : 'mod';
    for (let i = 0; i < n; i++) {
      const hasL = bl.a0 + i < bl.a1;
      const hasR = bl.b0 + i < bl.b1;
      rows.push({
        l: hasL ? left[bl.a0 + i] : undefined,
        r: hasR ? right[bl.b0 + i] : undefined,
        ln: hasL ? bl.a0 + i + 1 : undefined,
        rn: hasR ? bl.b0 + i + 1 : undefined,
        kind,
        start: i === 0,
      });
    }
    a = bl.a1;
    b = bl.b1;
  }
  equalUntil(left.length);
  return rows;
}

function sideText(s: LhSide): string[] {
  return s.text === undefined ? [] : splitLines(s.text);
}

/** Two-side diff of the selected revision, with line numbers, change highlighting and filler rows. */
export function DiffView({ left, right }: { left: LhSide; right: LhSide }) {
  const rows = useMemo(() => buildRows(sideText(left), sideText(right)), [left, right]);
  const lOff = (left.firstLine ?? 1) - 1;
  const rOff = (right.firstLine ?? 1) - 1;
  const changes = rows.filter(r => r.start).length;
  const note = (s: LhSide) => (s.missing ? 'File does not exist' : s.unavailable ? 'File content is not available' : undefined);
  return (
    <div class="diff">
      <div class="diff-titles">
        <div class="diff-title">
          {left.title}
          {note(left) && <span class="secondary"> · {note(left)}</span>}
        </div>
        <div class="diff-title">
          {right.title}
          {note(right) && <span class="secondary"> · {note(right)}</span>}
        </div>
      </div>
      <div class="diff-body mono" tabIndex={0}>
        {rows.length === 0 && <div class="empty-text">{changes === 0 ? 'Contents are identical' : ''}</div>}
        {rows.map((r, i) => (
          <div class={`diff-row ${r.kind}`} key={i}>
            <span class="ln">{r.ln !== undefined ? r.ln + lOff : ''}</span>
            <span class={`code ${r.l === undefined && r.kind ? 'filler' : ''}`}>{r.l ?? ''}</span>
            <span class="gap" />
            <span class="ln">{r.rn !== undefined ? r.rn + rOff : ''}</span>
            <span class={`code ${r.r === undefined && r.kind ? 'filler' : ''}`}>{r.r ?? ''}</span>
          </div>
        ))}
      </div>
      <div class="diff-status secondary">{changes === 0 ? 'No differences' : `${changes} ${changes === 1 ? 'difference' : 'differences'}`}</div>
    </div>
  );
}
