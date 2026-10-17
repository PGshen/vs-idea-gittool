// Line diff (Myers O(ND)) shared by the host and the webviews. Keep this file free of imports.

/** A changed region: lines [a0, a1) of the old text are replaced by lines [b0, b1) of the new text. */
export interface DiffBlock {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Splits text into lines without the line terminators. A trailing newline does not add an empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MAX_D = 4000;

/** Returns the changed blocks between `a` and `b`, in order. */
export function diffLines(a: string[], b: string[]): DiffBlock[] {
  // Common prefix / suffix are cheap and make the core much smaller.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const blocks = myers(A, B).map(x => ({ a0: x.a0 + pre, a1: x.a1 + pre, b0: x.b0 + pre, b1: x.b1 + pre }));
  return blocks;
}

function myers(a: string[], b: string[]): DiffBlock[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: 0, a1: n, b0: 0, b1: m }];
  // Hash lines to ints for fast comparison.
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const ai = Int32Array.from(a, id);
  const bi = Int32Array.from(b, id);
  const max = n + m;
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && ai[x] === bi[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [{ a0: 0, a1: n, b0: 0, b1: m }];
  // Backtrack to a list of matched pairs.
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  matches.reverse();
  const blocks: DiffBlock[] = [];
  let pa = 0;
  let pb = 0;
  for (const [mx, my] of matches) {
    if (mx > pa || my > pb) blocks.push({ a0: pa, a1: mx, b0: pb, b1: my });
    pa = mx + 1;
    pb = my + 1;
  }
  if (pa < n || pb < m) blocks.push({ a0: pa, a1: n, b0: pb, b1: m });
  return blocks;
}

/**
 * Maps a line range [start, end) of `b` to the corresponding range of `a` through the diff,
 * used by "Show History for Selection". Lines inside changed blocks map to the whole block.
 */
export function mapRangeBack(blocks: DiffBlock[], start: number, end: number): [number, number] {
  const locate = (line: number): { block?: DiffBlock; delta: number } => {
    let delta = 0;
    for (const bl of blocks) {
      if (line < bl.b0) break;
      if (line < bl.b1) return { block: bl, delta };
      delta = bl.a1 - bl.b1;
    }
    return { delta };
  };
  const s = locate(start);
  const s2 = s.block ? s.block.a0 : start + s.delta;
  if (end <= start) return [s2, s2];
  const e = locate(end - 1);
  const e2 = e.block ? e.block.a1 : end - 1 + e.delta + 1;
  return [s2, Math.max(s2, e2)];
}

/** Builds a unified diff (git style, 3 lines of context) of one file. */
export function unifiedDiff(oldPath: string | undefined, newPath: string | undefined, a: string[], b: string[], context = 3): string {
  const blocks = diffLines(a, b);
  if (!blocks.length && oldPath === newPath) return '';
  const name = newPath ?? oldPath ?? '';
  let out = `diff --git a/${oldPath ?? name} b/${newPath ?? name}\n`;
  if (!oldPath) out += 'new file mode 100644\n';
  if (!newPath) out += 'deleted file mode 100644\n';
  out += `--- ${oldPath ? `a/${oldPath}` : '/dev/null'}\n+++ ${newPath ? `b/${newPath}` : '/dev/null'}\n`;
  // Group blocks into hunks with context.
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].a0 - blocks[j].a1 <= context * 2) j++;
    const a0 = Math.max(0, blocks[i].a0 - context);
    const b0 = Math.max(0, blocks[i].b0 - context);
    const a1 = Math.min(a.length, blocks[j].a1 + context);
    const b1 = Math.min(b.length, blocks[j].b1 + context);
    const lines: string[] = [];
    let ap = a0;
    for (let k = i; k <= j; k++) {
      const bl = blocks[k];
      while (ap < bl.a0) lines.push(' ' + a[ap++]);
      for (let x = bl.a0; x < bl.a1; x++) lines.push('-' + a[x]);
      for (let y = bl.b0; y < bl.b1; y++) lines.push('+' + b[y]);
      ap = bl.a1;
    }
    while (ap < a1) lines.push(' ' + a[ap++]);
    const range = (s: number, len: number) => (len === 1 ? `${s + (len ? 1 : 0)}` : `${len ? s + 1 : s},${len}`);
    out += `@@ -${range(a0, a1 - a0)} +${range(b0, b1 - b0)} @@\n${lines.join('\n')}\n`;
    i = j + 1;
  }
  return out;
}
