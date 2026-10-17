// Port of IntelliJ's com.intellij.util.diff.Diff.buildChanges (Reindexer + MyersLCS), so that the
// tie-breaking of equal-length LCS candidates matches IntelliJ's diff and merge results.
// Keep this file free of imports.

export interface Change {
  /** Start in the first sequence, count of deleted elements. */
  line0: number;
  deleted: number;
  /** Start in the second sequence, count of inserted elements. */
  line1: number;
  inserted: number;
}

class BitSet {
  private readonly bits: Uint8Array;
  constructor(size: number) {
    this.bits = new Uint8Array(Math.max(1, size));
  }
  get(i: number) {
    return i >= 0 && i < this.bits.length ? this.bits[i] === 1 : false;
  }
  set(from: number, to: number, value = true) {
    for (let i = from; i < to && i < this.bits.length; i++) this.bits[i] = value ? 1 : 0;
  }
  setBit(i: number) {
    if (i >= 0 && i < this.bits.length) this.bits[i] = 1;
  }
}

class MyersLCS {
  private readonly vf: Int32Array;
  private readonly vb: Int32Array;
  readonly changes1: BitSet;
  readonly changes2: BitSet;

  constructor(
    private readonly first: Int32Array,
    private readonly second: Int32Array,
  ) {
    this.changes1 = new BitSet(first.length);
    this.changes2 = new BitSet(second.length);
    this.changes1.set(0, first.length);
    this.changes2.set(0, second.length);
    this.vf = new Int32Array(first.length + second.length + 1);
    this.vb = new Int32Array(first.length + second.length + 1);
  }

  executeWithThreshold() {
    const n = this.first.length + this.second.length;
    const threshold = Math.max(20000 + 10 * Math.floor(Math.sqrt(n)), 20000);
    if (this.first.length === 0 || this.second.length === 0) return;
    this.run(0, this.first.length, 0, this.second.length, Math.min(threshold, n));
  }

  private run(oldStart: number, oldEnd: number, newStart: number, newEnd: number, differenceEstimate: number) {
    if (!(oldStart < oldEnd && newStart < newEnd)) return;
    const oldLength = oldEnd - oldStart;
    const newLength = newEnd - newStart;
    const VF = this.vf;
    const VB = this.vb;
    VF[newLength + 1] = 0;
    VB[newLength + 1] = 0;
    const halfD = Math.floor((differenceEstimate + 1) / 2);
    let xx = -1;
    let kk = -1;
    let td = -1;
    loop: for (let d = 0; d <= halfD; d++) {
      const L = newLength + Math.max(-d, -newLength + ((d ^ newLength) & 1));
      const R = newLength + Math.min(d, oldLength - ((d ^ oldLength) & 1));
      for (let k = L; k <= R; k += 2) {
        let x = k === L || (k !== R && VF[k - 1] < VF[k + 1]) ? VF[k + 1] : VF[k - 1] + 1;
        const y = x - k + newLength;
        x += this.forward(oldStart + x, newStart + y, Math.min(oldEnd - oldStart - x, newEnd - newStart - y));
        VF[k] = x;
      }
      if ((oldLength - newLength) % 2 !== 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - (d - 1) <= k && k <= oldLength + (d - 1)) {
            if (VF[k] + VB[newLength + oldLength - k] >= oldLength) {
              xx = VF[k];
              kk = k;
              td = 2 * d - 1;
              break loop;
            }
          }
        }
      }
      for (let k = L; k <= R; k += 2) {
        let x = k === L || (k !== R && VB[k - 1] < VB[k + 1]) ? VB[k + 1] : VB[k - 1] + 1;
        const y = x - k + newLength;
        x += this.backward(oldEnd - 1 - x, newEnd - 1 - y, Math.min(oldEnd - oldStart - x, newEnd - newStart - y));
        VB[k] = x;
      }
      if ((oldLength - newLength) % 2 === 0) {
        for (let k = L; k <= R; k += 2) {
          if (oldLength - d <= k && k <= oldLength + d) {
            if (VF[oldLength + newLength - k] + VB[k] >= oldLength) {
              xx = oldLength - VB[k];
              kk = oldLength + newLength - k;
              td = 2 * d;
              break loop;
            }
          }
        }
      }
    }
    if (td > 1) {
      const yy = xx - kk + newLength;
      const oldDiff = Math.floor((td + 1) / 2);
      if (0 < xx && 0 < yy) this.run(oldStart, oldStart + xx, newStart, newStart + yy, oldDiff);
      if (oldStart + xx < oldEnd && newStart + yy < newEnd) this.run(oldStart + xx, oldEnd, newStart + yy, newEnd, td - oldDiff);
    } else if (td >= 0) {
      let x = oldStart;
      let y = newStart;
      while (x < oldEnd && y < newEnd) {
        const common = this.forward(x, y, Math.min(oldEnd - x, newEnd - y));
        if (common > 0) {
          this.changes1.set(x, x + common, false);
          this.changes2.set(y, y + common, false);
          x += common;
          y += common;
        } else if (oldEnd - oldStart > newEnd - newStart) x++;
        else y++;
      }
    }
    // td < 0: the difference is larger than the estimate; everything stays changed.
  }

  private forward(oldIndex: number, newIndex: number, maxLength: number) {
    let x = oldIndex;
    let y = newIndex;
    maxLength = Math.min(maxLength, Math.min(this.first.length - oldIndex, this.second.length - newIndex));
    while (x - oldIndex < maxLength && this.first[x] === this.second[y]) {
      x++;
      y++;
    }
    return x - oldIndex;
  }

  private backward(oldIndex: number, newIndex: number, maxLength: number) {
    let x = oldIndex;
    let y = newIndex;
    maxLength = Math.min(maxLength, Math.min(oldIndex, newIndex) + 1);
    while (oldIndex - x < maxLength && this.first[x] === this.second[y]) {
      x--;
      y--;
    }
    return oldIndex - x;
  }
}

/** Reindexer: drops elements that cannot be matched, runs the LCS, maps changes back. */
function buildCore(ints1: Int32Array, ints2: Int32Array): Change[] {
  const set2 = new Set(ints2);
  const old1: number[] = [];
  const disc1: number[] = [];
  ints1.forEach((v, i) => {
    if (set2.has(v)) {
      disc1.push(v);
      old1.push(i);
    }
  });
  const set1 = new Set(disc1);
  const old2: number[] = [];
  const disc2: number[] = [];
  ints2.forEach((v, i) => {
    if (set1.has(v)) {
      disc2.push(v);
      old2.push(i);
    }
  });
  const len1 = ints1.length;
  const len2 = ints2.length;
  if (disc1.length === 0 && disc2.length === 0) return [{ line0: 0, deleted: len1, line1: 0, inserted: len2 }];

  const lcs = new MyersLCS(Int32Array.from(disc1), Int32Array.from(disc2));
  lcs.executeWithThreshold();
  let changes1: BitSet;
  let changes2: BitSet;
  if (disc1.length === len1 && disc2.length === len2) {
    changes1 = lcs.changes1;
    changes2 = lcs.changes2;
  } else {
    changes1 = new BitSet(len1);
    changes2 = new BitSet(len2);
    const increment = (idx: number[], i: number, set: BitSet, length: number) => {
      if (i + 1 < idx.length) set.set(idx[i] + 1, idx[i + 1]);
      else set.set(idx[i] + 1, length);
      return i + 1;
    };
    let x = 0;
    let y = 0;
    while (x < disc1.length || y < disc2.length) {
      if (x < disc1.length && y < disc2.length && !lcs.changes1.get(x) && !lcs.changes2.get(y)) {
        x = increment(old1, x, changes1, len1);
        y = increment(old2, y, changes2, len2);
      } else if (lcs.changes1.get(x)) {
        changes1.setBit(old1[x]);
        x = increment(old1, x, changes1, len1);
      } else if (lcs.changes2.get(y)) {
        changes2.setBit(old2[y]);
        y = increment(old2, y, changes2, len2);
      } else break;
    }
    if (disc1.length === 0) changes1.set(0, len1);
    else changes1.set(0, old1[0]);
    if (disc2.length === 0) changes2.set(0, len2);
    else changes2.set(0, old2[0]);
  }
  const out: Change[] = [];
  let x = 0;
  let y = 0;
  while (x < len1 && y < len2) {
    while (x < len1 && y < len2 && !changes1.get(x) && !changes2.get(y)) {
      x++;
      y++;
    }
    const sx = x;
    const sy = y;
    while (x < len1 && changes1.get(x)) x++;
    while (y < len2 && changes2.get(y)) y++;
    if (x !== sx || y !== sy) out.push({ line0: sx, deleted: x - sx, line1: sy, inserted: y - sy });
  }
  if (x !== len1 || y !== len2) out.push({ line0: x, deleted: len1 - x, line1: y, inserted: len2 - y });
  return out;
}

/** Diff.buildChanges on sequences of comparable keys. Returns the changes in order. */
export function buildChanges<T>(a: readonly T[], b: readonly T[]): Change[] {
  let start = 0;
  const min = Math.min(a.length, b.length);
  while (start < min && a[start] === b[start]) start++;
  let end = 0;
  while (end < min - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const l1 = a.length - start - end;
  const l2 = b.length - start - end;
  if (l1 === 0 || l2 === 0) return l1 === 0 && l2 === 0 ? [] : [{ line0: start, deleted: l1, line1: start, inserted: l2 }];
  const ids = new Map<T, number>();
  const id = (v: T) => {
    let n = ids.get(v);
    if (n === undefined) ids.set(v, (n = ids.size + 1));
    return n;
  };
  const i1 = new Int32Array(l1);
  const i2 = new Int32Array(l2);
  for (let i = 0; i < l1; i++) i1[i] = id(a[start + i]);
  for (let i = 0; i < l2; i++) i2[i] = id(b[start + i]);
  return buildCore(i1, i2).map(c => ({ line0: c.line0 + start, deleted: c.deleted, line1: c.line1 + start, inserted: c.inserted }));
}
