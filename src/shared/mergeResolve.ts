// Port of IntelliJ's MergeResolveUtil ("Resolve Simple Conflicts" / magic wand) with the parts of
// ByWordRt, ByCharRt, ChunkOptimizer, ComparisonMergeUtil and TrimUtil it depends on.
// Keep this file free of non-shared imports.

import { buildChanges } from './intellijDiff';

export type ComparisonPolicy = 'default' | 'ignoreWhitespaces';

/** A pair of equal (unchanged) ranges [s1, e1) and [s2, e2). */
interface Range {
  s1: number;
  e1: number;
  s2: number;
  e2: number;
}

/** Three-way range: 1 = left, 2 = base, 3 = right (ByWordRt.compare(left, base, right) order). */
interface MergeRange {
  s1: number;
  e1: number;
  s2: number;
  e2: number;
  s3: number;
  e3: number;
}

/** FairDiffIterable: the unchanged ranges of two sequences, in order. */
interface Iterable2 {
  unchanged: Range[];
  len1: number;
  len2: number;
}

function changesOf(it: Iterable2): Range[] {
  const out: Range[] = [];
  let p1 = 0;
  let p2 = 0;
  for (const u of it.unchanged) {
    if (u.s1 > p1 || u.s2 > p2) out.push({ s1: p1, e1: u.s1, s2: p2, e2: u.s2 });
    p1 = u.e1;
    p2 = u.e2;
  }
  if (p1 < it.len1 || p2 < it.len2) out.push({ s1: p1, e1: it.len1, s2: p2, e2: it.len2 });
  return out;
}

/** DiffIterableUtil.ChangeBuilder: collects equal ranges in order. */
class ChangeBuilder {
  private readonly ranges: Range[] = [];
  constructor(
    private readonly len1: number,
    private readonly len2: number,
  ) {}

  markEqual(s1: number, s2: number, e1 = s1 + 1, e2 = s2 + 1) {
    if (s1 === e1 && s2 === e2) return;
    const last = this.ranges[this.ranges.length - 1];
    if (last && last.e1 === s1 && last.e2 === s2) {
      last.e1 = e1;
      last.e2 = e2;
    } else this.ranges.push({ s1, e1, s2, e2 });
  }

  finish(): Iterable2 {
    return { unchanged: this.ranges, len1: this.len1, len2: this.len2 };
  }
}

/** DiffIterableUtil.diff on arbitrary keys. */
function diffKeys(a: string[], b: string[]): Iterable2 {
  const unchanged: Range[] = [];
  let p1 = 0;
  let p2 = 0;
  for (const c of buildChanges(a, b)) {
    if (c.line0 > p1) unchanged.push({ s1: p1, e1: c.line0, s2: p2, e2: c.line1 });
    p1 = c.line0 + c.deleted;
    p2 = c.line1 + c.inserted;
  }
  if (p1 < a.length) unchanged.push({ s1: p1, e1: a.length, s2: p2, e2: b.length });
  return { unchanged, len1: a.length, len2: b.length };
}

// ---------------------------------------------------------------- characters (TrimUtil)

const isSpaceEnterOrTab = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function isPunctuation(code: number): boolean {
  if (code === 95) return false; // '_'
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function isWhiteSpaceCodePoint(c: number) {
  return c < 128 && isSpaceEnterOrTab(String.fromCharCode(c));
}

function isAlpha(c: number) {
  if (isWhiteSpaceCodePoint(c)) return false;
  return !isPunctuation(c);
}

const CONTINUOUS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Javanese}]/u;
const ALPHABETIC = /\p{Alphabetic}/u;
const DIGIT = /\p{Nd}/u;

function isContinuousScript(c: number) {
  if (c < 128) return false;
  const s = String.fromCodePoint(c);
  if (DIGIT.test(s)) return false;
  if (c > 0xffff) return true;
  if (CONTINUOUS.test(s)) return true;
  return !ALPHABETIC.test(s);
}

function ignoreWs(s: string) {
  return s.replace(/[ \t\n\r]/g, '');
}

function isEqualTexts(a: string, b: string, policy: ComparisonPolicy) {
  return policy === 'default' ? a === b : ignoreWs(a) === ignoreWs(b);
}

// ---------------------------------------------------------------- inline chunks (ByWordRt.getInlineChunks)

interface InlineChunk {
  newline: boolean;
  /** offset1 / offset2 in the text */
  start: number;
  end: number;
  key: string;
}

export function getInlineChunks(text: string): InlineChunk[] {
  const chunks: InlineChunk[] = [];
  let wordStart = -1;
  let offset = 0;
  while (offset < text.length) {
    const ch = text.codePointAt(offset)!;
    const count = ch > 0xffff ? 2 : 1;
    const alpha = isAlpha(ch);
    const wordPart = alpha && !isContinuousScript(ch);
    if (wordPart) {
      if (wordStart === -1) wordStart = offset;
    } else {
      if (wordStart !== -1) {
        chunks.push({ newline: false, start: wordStart, end: offset, key: text.slice(wordStart, offset) });
        wordStart = -1;
      }
      if (alpha) chunks.push({ newline: false, start: offset, end: offset + count, key: text.slice(offset, offset + count) });
      else if (ch === 10) chunks.push({ newline: true, start: offset, end: offset + 1, key: '\n' });
    }
    offset += count;
  }
  if (wordStart !== -1) chunks.push({ newline: false, start: wordStart, end: text.length, key: text.slice(wordStart) });
  return chunks;
}

// ---------------------------------------------------------------- ChunkOptimizer.WordChunkOptimizer

function expandForwardList(d1: InlineChunk[], d2: InlineChunk[], s1: number, s2: number, e1: number, e2: number): number {
  const old = s1;
  while (s1 < e1 && s2 < e2 && s1 < d1.length && s2 < d2.length && d1[s1].key === d2[s2].key) {
    s1++;
    s2++;
  }
  return s1 - old;
}

function expandBackwardList(d1: InlineChunk[], d2: InlineChunk[], s1: number, s2: number, e1: number, e2: number): number {
  const old = e1;
  while (s1 < e1 && s2 < e2 && e1 - 1 >= 0 && e2 - 1 >= 0 && d1[e1 - 1].key === d2[e2 - 1].key) {
    e1--;
    e2--;
  }
  return old - e1;
}

function isSeparatedWithWhitespace(text: string, w1: InlineChunk, w2: InlineChunk) {
  if (w1.newline || w2.newline) return true;
  for (let i = w1.end; i < w2.start; i++) if (isSpaceEnterOrTab(text[i])) return true;
  return false;
}

function findSequenceEdgeShift(text: string, words: InlineChunk[], offset: number, count: number, leftToRight: boolean): number {
  for (let i = 0; i < count; i++) {
    const [w1, w2] = leftToRight ? [words[offset + i], words[offset + i + 1]] : [words[offset - i - 1], words[offset - i]];
    if (w1 && w2 && isSeparatedWithWhitespace(text, w1, w2)) return i + 1;
  }
  return -1;
}

function optimizeWordChunks(text1: string, text2: string, words1: InlineChunk[], words2: InlineChunk[], it: Iterable2): Iterable2 {
  const ranges: Range[] = [];
  const getShift = (touchLeft: boolean, equalForward: number, equalBackward: number, r2: Range): number => {
    const words = touchLeft ? words1 : words2;
    const text = touchLeft ? text1 : text2;
    const touchStart = touchLeft ? r2.s1 : r2.s2;
    if (isSeparatedWithWhitespace(text, words[touchStart - 1], words[touchStart])) return 0;
    const left = findSequenceEdgeShift(text, words, touchStart, equalForward, true);
    if (left > 0) return left;
    const right = findSequenceEdgeShift(text, words, touchStart - 1, equalBackward, false);
    if (right > 0) return -right;
    return 0;
  };
  const process = () => {
    if (ranges.length < 2) return;
    const r1 = ranges[ranges.length - 2];
    const r2 = ranges[ranges.length - 1];
    if (r1.e1 !== r2.s1 && r1.e2 !== r2.s2) return;
    const count1 = r1.e1 - r1.s1;
    const count2 = r2.e1 - r2.s1;
    const equalForward = expandForwardList(words1, words2, r1.e1, r1.e2, r1.e1 + count2, r1.e2 + count2);
    const equalBackward = expandBackwardList(words1, words2, r2.s1 - count1, r2.s2 - count1, r2.s1, r2.s2);
    if (equalForward === 0 && equalBackward === 0) return;
    if (equalForward === count2) {
      ranges.splice(ranges.length - 2, 2, { s1: r1.s1, e1: r1.e1 + count2, s2: r1.s2, e2: r1.e2 + count2 });
      process();
      return;
    }
    if (equalBackward === count1) {
      ranges.splice(ranges.length - 2, 2, { s1: r2.s1 - count1, e1: r2.e1, s2: r2.s2 - count1, e2: r2.e2 });
      process();
      return;
    }
    const touchLeft = r1.e1 === r2.s1;
    const shift = getShift(touchLeft, equalForward, equalBackward, r2);
    if (shift !== 0) {
      ranges.splice(
        ranges.length - 2,
        2,
        { s1: r1.s1, e1: r1.e1 + shift, s2: r1.s2, e2: r1.e2 + shift },
        { s1: r2.s1 + shift, e1: r2.e1, s2: r2.s2 + shift, e2: r2.e2 },
      );
    }
  };
  for (const r of it.unchanged) {
    ranges.push({ ...r });
    process();
  }
  return { unchanged: ranges.filter(r => r.e1 > r.s1), len1: words1.length, len2: words2.length };
}

// ---------------------------------------------------------------- punctuation (ByCharRt.comparePunctuation)

function comparePunctuation(text1: string, text2: string): Iterable2 {
  const p1: number[] = [];
  const p2: number[] = [];
  for (let i = 0; i < text1.length; i++) if (isPunctuation(text1.charCodeAt(i))) p1.push(i);
  for (let i = 0; i < text2.length; i++) if (isPunctuation(text2.charCodeAt(i))) p2.push(i);
  const it = diffKeys(
    p1.map(i => text1[i]),
    p2.map(i => text2[i]),
  );
  const b = new ChangeBuilder(text1.length, text2.length);
  for (const r of it.unchanged) for (let i = 0; i < r.e1 - r.s1; i++) b.markEqual(p1[r.s1 + i], p2[r.s2 + i]);
  return b.finish();
}

/** Compare one sequence with two others as if they were one (ByWordRt.comparePunctuation2Side). */
function comparePunctuation2Side(text1: string, text21: string, text22: string): [Iterable2, Iterable2] {
  const changes = comparePunctuation(text1, text21 + text22);
  const offset = text21.length;
  const r1: Range[] = [];
  const r2: Range[] = [];
  for (const ch of changes.unchanged) {
    if (ch.e2 <= offset) r1.push({ ...ch });
    else if (ch.s2 >= offset) r2.push({ s1: ch.s1, e1: ch.e1, s2: ch.s2 - offset, e2: ch.e2 - offset });
    else {
      const len2 = offset - ch.s2;
      r1.push({ s1: ch.s1, e1: ch.s1 + len2, s2: ch.s2, e2: offset });
      r2.push({ s1: ch.s1 + len2, e1: ch.e1, s2: 0, e2: ch.e2 - offset });
    }
  }
  return [
    { unchanged: r1, len1: text1.length, len2: text21.length },
    { unchanged: r2, len1: text1.length, len2: text22.length },
  ];
}

// ---------------------------------------------------------------- ByWordRt.AdjustmentPunctuationMatcher

function matchAdjustmentDelimiters(text1: string, text2: string, words1: InlineChunk[], words2: InlineChunk[], changes: Iterable2): Iterable2 {
  const len1 = text1.length;
  const len2 = text2.length;
  const builder = new ChangeBuilder(len1, len2);
  let lastStart1 = -1;
  let lastStart2 = -1;
  let lastEnd1 = -1;
  let lastEnd2 = -1;
  const so1 = (i: number) => words1[i].start;
  const so2 = (i: number) => words2[i].start;
  const eo1 = (i: number) => words1[i].end;
  const eo2 = (i: number) => words2[i].end;

  const matchRange = (s1: number, s2: number, e1: number, e2: number) => {
    if (s1 === e1 && s2 === e2) return;
    const ch = comparePunctuation(text1.slice(s1, e1), text2.slice(s2, e2));
    for (const r of ch.unchanged) builder.markEqual(s1 + r.s1, s2 + r.s2, s1 + r.e1, s2 + r.e2);
  };
  const matchComplexRangeLeft = (s1: number, e1: number, s12: number, e12: number, s22: number, e22: number) => {
    const [a, b] = comparePunctuation2Side(text1.slice(s1, e1), text2.slice(s12, e12), text2.slice(s22, e22));
    for (const r of a.unchanged) builder.markEqual(s1 + r.s1, s12 + r.s2, s1 + r.e1, s12 + r.e2);
    for (const r of b.unchanged) builder.markEqual(s1 + r.s1, s22 + r.s2, s1 + r.e1, s22 + r.e2);
  };
  const matchComplexRangeRight = (s2: number, e2: number, s11: number, e11: number, s21: number, e21: number) => {
    const [a, b] = comparePunctuation2Side(text2.slice(s2, e2), text1.slice(s11, e11), text1.slice(s21, e21));
    for (const r of a.unchanged) builder.markEqual(s11 + r.s2, s2 + r.s1, s11 + r.e2, s2 + r.e1);
    for (const r of b.unchanged) builder.markEqual(s21 + r.s2, s2 + r.s1, s21 + r.e2, s2 + r.e1);
  };
  const matchBackwardRange = (s1: number, s2: number, e1: number, e2: number) => {
    if (lastStart1 === s1 && lastStart2 === s2) {
      matchRange(s1, s2, e1, e2);
      return;
    }
    if (lastStart1 < s1 && lastStart2 < s2) {
      matchRange(lastStart1, lastStart2, lastEnd1, lastEnd2);
      matchRange(s1, s2, e1, e2);
      return;
    }
    if (lastStart1 === s1 && lastEnd1 === e1) matchComplexRangeLeft(s1, e1, lastStart2, lastEnd2, s2, e2);
    else if (lastStart2 === s2 && lastEnd2 === e2) matchComplexRangeRight(s2, e2, lastStart1, lastEnd1, s1, e1);
    else throw new Error('IllegalState');
  };
  const matchBackward = (i1: number, i2: number) => {
    const s1 = i1 === 0 ? 0 : eo1(i1 - 1);
    const s2 = i2 === 0 ? 0 : eo2(i2 - 1);
    const e1 = i1 === words1.length ? len1 : so1(i1);
    const e2 = i2 === words2.length ? len2 : so2(i2);
    matchBackwardRange(s1, s2, e1, e2);
    lastStart1 = lastStart2 = lastEnd1 = lastEnd2 = -1;
  };
  const matchForward = (i1: number, i2: number) => {
    lastStart1 = i1 === -1 ? 0 : eo1(i1);
    lastStart2 = i2 === -1 ? 0 : eo2(i2);
    lastEnd1 = i1 + 1 === words1.length ? len1 : so1(i1 + 1);
    lastEnd2 = i2 + 1 === words2.length ? len2 : so2(i2 + 1);
  };

  matchForward(-1, -1);
  for (const ch of changes.unchanged) {
    for (let i = 0; i < ch.e1 - ch.s1; i++) {
      const i1 = ch.s1 + i;
      const i2 = ch.s2 + i;
      matchBackward(i1, i2);
      builder.markEqual(so1(i1), so2(i2), eo1(i1), eo2(i2));
      matchForward(i1, i2);
    }
  }
  matchBackward(words1.length, words2.length);
  return builder.finish();
}

// ---------------------------------------------------------------- whitespace correctors (ByWordRt / TrimUtil)

function expandIgnoredForward2(t1: string, t2: string, s1: number, s2: number, e1: number, e2: number): number {
  const old = s1;
  while (s1 < e1 && s2 < e2 && t1[s1] === t2[s2] && isSpaceEnterOrTab(t1[s1])) {
    s1++;
    s2++;
  }
  return s1 - old;
}

function expandIgnoredBackward2(t1: string, t2: string, s1: number, s2: number, e1: number, e2: number): number {
  const old = e1;
  while (s1 < e1 && s2 < e2 && t1[e1 - 1] === t2[e2 - 1] && isSpaceEnterOrTab(t1[e1 - 1])) {
    e1--;
    e2--;
  }
  return old - e1;
}

function trimStart(t: string, s: number, e: number) {
  while (s < e && isSpaceEnterOrTab(t[s])) s++;
  return s;
}

function trimEnd(t: string, s: number, e: number) {
  while (s < e && isSpaceEnterOrTab(t[e - 1])) e--;
  return e;
}

function correct2(text1: string, text2: string, it: Iterable2, policy: ComparisonPolicy): Range[] {
  const out: Range[] = [];
  for (const r of changesOf(it)) {
    if (policy === 'default') {
      const endCut = expandIgnoredBackward2(text1, text2, r.s1, r.s2, r.e1, r.e2);
      const startCut = expandIgnoredForward2(text1, text2, r.s1, r.s2, r.e1 - endCut, r.e2 - endCut);
      const x = { s1: r.s1 + startCut, e1: r.e1 - endCut, s2: r.s2 + startCut, e2: r.e2 - endCut };
      if (x.s1 !== x.e1 || x.s2 !== x.e2) out.push(x);
    } else {
      const f = expandIgnoredForward2(text1, text2, r.s1, r.s2, r.e1, r.e2);
      let s1 = r.s1 + f;
      let s2 = r.s2 + f;
      const b = expandIgnoredBackward2(text1, text2, s1, s2, r.e1, r.e2);
      let e1 = r.e1 - b;
      let e2 = r.e2 - b;
      s1 = trimStart(text1, s1, e1);
      e1 = trimEnd(text1, s1, e1);
      s2 = trimStart(text2, s2, e2);
      e2 = trimEnd(text2, s2, e2);
      if ((s1 !== e1 || s2 !== e2) && !isEqualTexts(text1.slice(s1, e1), text2.slice(s2, e2), 'ignoreWhitespaces')) out.push({ s1, e1, s2, e2 });
    }
  }
  return out;
}

function expandIgnored3(t1: string, t2: string, t3: string, r: MergeRange, forward: boolean): number {
  let { s1, s2, s3, e1, e2, e3 } = r;
  if (forward) {
    const old = s1;
    while (s1 < e1 && s2 < e2 && s3 < e3 && t1[s1] === t2[s2] && t1[s1] === t3[s3] && isSpaceEnterOrTab(t1[s1])) {
      s1++;
      s2++;
      s3++;
    }
    return s1 - old;
  }
  const old = e1;
  while (s1 < e1 && s2 < e2 && s3 < e3 && t1[e1 - 1] === t2[e2 - 1] && t1[e1 - 1] === t3[e3 - 1] && isSpaceEnterOrTab(t1[e1 - 1])) {
    e1--;
    e2--;
    e3--;
  }
  return old - e1;
}

const isEmpty3 = (r: MergeRange) => r.s1 === r.e1 && r.s2 === r.e2 && r.s3 === r.e3;

function correct3(t1: string, t2: string, t3: string, conflicts: MergeRange[], policy: ComparisonPolicy): MergeRange[] {
  const out: MergeRange[] = [];
  for (const r of conflicts) {
    if (policy === 'default') {
      const endCut = expandIgnored3(t1, t2, t3, r, false);
      const reduced = { ...r, e1: r.e1 - endCut, e2: r.e2 - endCut, e3: r.e3 - endCut };
      const startCut = expandIgnored3(t1, t2, t3, reduced, true);
      const x = { s1: r.s1 + startCut, e1: r.e1 - endCut, s2: r.s2 + startCut, e2: r.e2 - endCut, s3: r.s3 + startCut, e3: r.e3 - endCut };
      if (!isEmpty3(x)) out.push(x);
    } else {
      const f = expandIgnored3(t1, t2, t3, r, true);
      const a = { ...r, s1: r.s1 + f, s2: r.s2 + f, s3: r.s3 + f };
      const b = expandIgnored3(t1, t2, t3, a, false);
      const x = { ...a, e1: a.e1 - b, e2: a.e2 - b, e3: a.e3 - b };
      x.s1 = trimStart(t1, x.s1, x.e1);
      x.e1 = trimEnd(t1, x.s1, x.e1);
      x.s2 = trimStart(t2, x.s2, x.e2);
      x.e2 = trimEnd(t2, x.s2, x.e2);
      x.s3 = trimStart(t3, x.s3, x.e3);
      x.e3 = trimEnd(t3, x.s3, x.e3);
      const s1 = t1.slice(x.s1, x.e1);
      const s2 = t2.slice(x.s2, x.e2);
      const s3 = t3.slice(x.s3, x.e3);
      const equal = isEqualTexts(s2, s1, 'ignoreWhitespaces') && isEqualTexts(s2, s3, 'ignoreWhitespaces');
      if (!isEmpty3(x) && !equal) out.push(x);
    }
  }
  return out;
}

// ---------------------------------------------------------------- ComparisonMergeUtil.buildSimple

/** Combines base->left and base->right into merge ranges (left, base, right). */
function buildSimple(f1: Iterable2, f2: Iterable2): MergeRange[] {
  const out: MergeRange[] = [];
  let i1 = 0;
  let i2 = 0;
  let i3 = 0;
  const process = (s1: number, s2: number, s3: number, e1: number, e2: number, e3: number) => {
    if (s1 === e1 && s2 === e2 && s3 === e3) return;
    out.push({ s1, e1, s2, e2, s3, e3 });
  };
  const markEqual = (s1: number, s2: number, s3: number, e1: number, e2: number, e3: number) => {
    process(i1, i2, i3, s1, s2, s3);
    i1 = e1;
    i2 = e2;
    i3 = e3;
  };
  let a = 0;
  let b = 0;
  const u1 = f1.unchanged;
  const u2 = f2.unchanged;
  while (a < u1.length && b < u2.length) {
    const r1 = u1[a];
    const r2 = u2[b];
    if (r1.e1 <= r2.s1) {
      a++;
      continue;
    }
    if (r2.e1 <= r1.s1) {
      b++;
      continue;
    }
    const startBase = Math.max(r1.s1, r2.s1);
    const endBase = Math.min(r1.e1, r2.e1);
    const count = endBase - startBase;
    const startLeft = r1.s2 + (startBase - r1.s1);
    const startRight = r2.s2 + (startBase - r2.s1);
    markEqual(startLeft, startBase, startRight, startLeft + count, endBase, startRight + count);
    if (r1.e1 <= r2.e1) a++;
    else b++;
  }
  process(i1, i2, i3, f1.len2, f1.len1, f2.len2);
  return out;
}

// ---------------------------------------------------------------- ByWordRt.compare

/** Two-way word comparison: changed ranges (1 = text1, 2 = text2). */
export function compareWords2(text1: string, text2: string, policy: ComparisonPolicy): Range[] {
  const w1 = getInlineChunks(text1);
  const w2 = getInlineChunks(text2);
  let ch = diffKeys(
    w1.map(w => w.key),
    w2.map(w => w.key),
  );
  ch = optimizeWordChunks(text1, text2, w1, w2, ch);
  const delimiters = matchAdjustmentDelimiters(text1, text2, w1, w2, ch);
  return correct2(text1, text2, delimiters, policy);
}

/** Three-way word comparison of left, base, right: conflicting ranges (1 = left, 2 = base, 3 = right). */
export function compareWords3(left: string, base: string, right: string, policy: ComparisonPolicy): MergeRange[] {
  const wl = getInlineChunks(left);
  const wb = getInlineChunks(base);
  const wr = getInlineChunks(right);
  let c1 = diffKeys(
    wb.map(w => w.key),
    wl.map(w => w.key),
  );
  c1 = optimizeWordChunks(base, left, wb, wl, c1);
  const it1 = matchAdjustmentDelimiters(base, left, wb, wl, c1);
  let c2 = diffKeys(
    wb.map(w => w.key),
    wr.map(w => w.key),
  );
  c2 = optimizeWordChunks(base, right, wb, wr, c2);
  const it2 = matchAdjustmentDelimiters(base, right, wb, wr, c2);
  const conflicts = buildSimple(it1, it2);
  return correct3(left, base, right, conflicts, policy);
}

// ---------------------------------------------------------------- MergeRangeUtil.getWordMergeType

interface ConflictType {
  conflict: boolean;
  left: boolean;
  right: boolean;
}

function wordMergeType(r: MergeRange, texts: [string, string, string], policy: ComparisonPolicy): ConflictType {
  const empty = [r.s1 === r.e1, r.s2 === r.e2, r.s3 === r.e3];
  const content = [texts[0].slice(r.s1, r.e1), texts[1].slice(r.s2, r.e2), texts[2].slice(r.s3, r.e3)];
  const eq = (a: number, b: number) => isEqualTexts(content[a], content[b], policy);
  const [isLeftEmpty, isBaseEmpty, isRightEmpty] = empty;
  if (isBaseEmpty) {
    if (isLeftEmpty) return { conflict: false, left: false, right: true };
    if (isRightEmpty) return { conflict: false, left: true, right: false };
    return eq(0, 2) ? { conflict: false, left: true, right: true } : { conflict: true, left: true, right: true };
  }
  if (isLeftEmpty && isRightEmpty) return { conflict: false, left: true, right: true };
  const unchangedLeft = eq(1, 0);
  const unchangedRight = eq(1, 2);
  if (unchangedLeft && unchangedRight) throw new Error('trueEquality required');
  if (unchangedLeft) return { conflict: false, left: false, right: true };
  if (unchangedRight) return { conflict: false, left: true, right: false };
  if (eq(0, 2)) return { conflict: false, left: true, right: true };
  return { conflict: true, left: true, right: true };
}

// ---------------------------------------------------------------- MergeResolveUtil

function simpleResolve(left: string, base: string, right: string, policy: ComparisonPolicy): string | undefined {
  const texts: [string, string, string] = [left, base, right];
  const changes = compareWords3(left, base, right, policy);
  let out = '';
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  const next = (e1: number, e2: number, e3: number): MergeRange => {
    const r = { s1: l1, e1, s2: l2, e2, s3: l3, e3 };
    l1 = e1;
    l2 = e2;
    l3 = e3;
    return r;
  };
  const append = (r: MergeRange, side: 0 | 1 | 2) => {
    out += side === 0 ? left.slice(r.s1, r.e1) : side === 1 ? base.slice(r.s2, r.e2) : right.slice(r.s3, r.e3);
  };
  const appendBase = (r: MergeRange) => {
    if (isEmpty3(r)) return;
    const b = base.slice(r.s2, r.e2);
    if (b === left.slice(r.s1, r.e1) && b === right.slice(r.s3, r.e3)) {
      append(r, 1);
      return;
    }
    const t = wordMergeType(r, texts, 'default');
    if (t.left) append(r, 0);
    else if (t.right) append(r, 2);
    else append(r, 1);
  };
  for (const f of changes) {
    appendBase(next(f.s1, f.s2, f.s3));
    const conflict = next(f.e1, f.e2, f.e3);
    const t = wordMergeType(conflict, texts, policy);
    if (t.conflict) return undefined;
    append(conflict, t.left ? 0 : 2);
  }
  appendBase(next(left.length, base.length, right.length));
  return out;
}

function greedyResolve(left: string, base: string, right: string, policy: ComparisonPolicy): string | undefined {
  const f1 = compareWords2(base, left, policy);
  const f2 = compareWords2(base, right, policy);
  let out = '';
  let lastBase = 0;
  let i1 = 0;
  let i2 = 0;
  const appendBase = (end: number) => {
    if (lastBase === end) return;
    out += base.slice(lastBase, end);
    lastBase = end;
  };
  const inserted = (fr: Range[], s: number, e: number, text: string) =>
    fr
      .slice(s, e)
      .map(f => text.slice(f.s2, f.e2))
      .join('');
  for (;;) {
    const c1 = f1[i1]?.s1 ?? -1;
    const c2 = f2[i2]?.s1 ?? -1;
    if (c1 === -1 && c2 === -1) {
      appendBase(base.length);
      break;
    }
    if (c1 !== -1 && c2 !== -1) appendBase(Math.min(c1, c2));
    else appendBase(c1 !== -1 ? c1 : c2);
    let baseEnd = lastBase;
    let e1 = i1;
    let e2 = i2;
    for (;;) {
      const n1 = f1[e1];
      const n2 = f2[e2];
      if (n1 && n1.s1 <= baseEnd) {
        baseEnd = Math.max(baseEnd, n1.e1);
        e1++;
        continue;
      }
      if (n2 && n2.s1 <= baseEnd) {
        baseEnd = Math.max(baseEnd, n2.e1);
        e2++;
        continue;
      }
      break;
    }
    const ins1 = inserted(f1, i1, e1, left);
    const ins2 = inserted(f2, i2, e2, right);
    i1 = e1;
    i2 = e2;
    lastBase = baseEnd;
    if (!ins1 && !ins2) continue;
    if (!ins2) {
      out += ins1;
      continue;
    }
    if (!ins1) {
      out += ins2;
      continue;
    }
    if (isEqualTexts(ins1, ins2, policy)) {
      out += ins1.length <= ins2.length ? ins1 : ins2;
      continue;
    }
    return undefined;
  }
  return out;
}

/** MergeResolveUtil.tryResolve: word-level merge of a conflict; undefined when it cannot be resolved. */
export function tryResolve(left: string, base: string, right: string): string | undefined {
  try {
    return simpleResolve(left, base, right, 'default') ?? simpleResolve(left, base, right, 'ignoreWhitespaces');
  } catch {
    return undefined;
  }
}

/** MergeResolveUtil.tryGreedyResolve */
export function tryGreedyResolve(left: string, base: string, right: string): string | undefined {
  try {
    return greedyResolve(left, base, right, 'default') ?? greedyResolve(left, base, right, 'ignoreWhitespaces');
  } catch {
    return undefined;
  }
}

/**
 * Word-level inner differences of a change (MergeInnerDifferences of DiffUtil.compareThreesideInner):
 * character ranges relative to each text. The base gets every fragment, a side only the fragments it changed.
 */
export function innerDifferences(
  left: string,
  base: string,
  right: string,
  policy: ComparisonPolicy = 'default',
): { left: [number, number][]; base: [number, number][]; right: [number, number][] } {
  const out = { left: [] as [number, number][], base: [] as [number, number][], right: [] as [number, number][] };
  let fragments: MergeRange[];
  try {
    fragments = compareWords3(left, base, right, policy);
  } catch {
    return { left: [[0, left.length]], base: [[0, base.length]], right: [[0, right.length]] };
  }
  const texts: [string, string, string] = [left, base, right];
  for (const f of fragments) {
    let t: ConflictType;
    try {
      t = wordMergeType(f, texts, policy);
    } catch {
      t = { conflict: false, left: true, right: true };
    }
    if (f.e2 > f.s2) out.base.push([f.s2, f.e2]);
    if (t.left && f.e1 > f.s1) out.left.push([f.s1, f.e1]);
    if (t.right && f.e3 > f.s3) out.right.push([f.s3, f.e3]);
  }
  return out;
}
