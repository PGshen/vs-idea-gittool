import { Repository } from '../../git/repository';
import { DiffHunk, FileDiffResult } from '../../shared/logProtocol';
import { Change } from '../../shared/types';
import { EMPTY_TREE } from './details';

const MAX_LINES = 20000;

/** Parses unified diff output (one file) into hunks. */
export function parseUnifiedDiff(out: string): { binary: boolean; hunks: DiffHunk[] } {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined;
  let binary = false;
  for (const line of out.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      continue;
    }
    const t = line[0];
    if (t === ' ' || t === '-' || t === '+') cur.lines.push({ t, s: line.slice(1) });
    // "\ No newline at end of file" and the trailing empty line are skipped.
  }
  return { binary, hunks };
}

async function lineCount(repo: Repository, rev: string, path: string): Promise<number> {
  if (rev === EMPTY_TREE) return 0;
  const r = await repo.exec(['cat-file', '-p', `${rev}:${path}`], { allowFailure: true, quiet: true, binary: true });
  if (r.exitCode !== 0 || !r.buffer) return 0;
  let n = 0;
  for (const b of r.buffer) if (b === 10) n++;
  if (r.buffer.length && r.buffer[r.buffer.length - 1] !== 10) n++;
  return n;
}

/**
 * Diff of one file between two revisions for the diff preview of the log.
 * `context` is the number of unchanged lines around changes; a large value shows the whole file.
 */
export async function fileDiff(repo: Repository, change: Change, left: string, right: string, context: number): Promise<FileDiffResult> {
  const l = left || EMPTY_TREE;
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  const out = await repo.execText(['diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, l, right, '--', ...paths], { quiet: true, allowFailure: true });
  const { binary, hunks } = parseUnifiedDiff(out);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const [oldTotal, newTotal] = await Promise.all([
    change.status === 'A' ? 0 : lineCount(repo, l, change.oldPath ?? change.path),
    change.status === 'D' ? 0 : lineCount(repo, right, change.path),
  ]);
  if (total > MAX_LINES) return { path: change.path, oldPath: change.oldPath, binary, tooLarge: true, hunks: [], oldTotal, newTotal };
  return { path: change.path, oldPath: change.oldPath, binary, hunks, oldTotal, newTotal };
}
