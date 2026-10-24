import { ChildProcess, spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { Commit } from '../shared/types';
import { getGitPath } from './exec';
import { log } from '../host/output';

// %H parents author-name author-email author-date committer-name committer-email commit-date refs subject
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s'].join('%x00') + '%x01';

export function parseLogRecord(root: string, rec: string): Commit | undefined {
  const r = rec.startsWith('\n') ? rec.slice(1) : rec;
  if (!r) return undefined;
  const f = r.split('\0');
  if (f.length < 10) return undefined;
  return {
    hash: f[0],
    parents: f[1] ? f[1].split(' ') : [],
    authorName: f[2],
    authorEmail: f[3],
    authorDate: +f[4],
    committerName: f[5],
    committerEmail: f[6],
    commitDate: +f[7],
    refs: parseDecorations(f[8]),
    subject: f[9],
    root,
  };
}

/** Parses `%D` with --decorate=full ("HEAD -> refs/heads/master, refs/remotes/origin/master, tag: refs/tags/v1"). */
export function parseDecorations(d: string): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (let part of d.split(', ')) {
    if (part.startsWith('HEAD -> ')) {
      out.push('HEAD');
      part = part.slice(8);
    }
    if (part.startsWith('tag: ')) part = part.slice(5);
    out.push(part);
  }
  return out;
}

/**
 * Streams `git log` output and hands out commits page by page. The git process is paused
 * (backpressure) between pages, so huge histories are not read fully before the first page shows.
 */
export class LogStream {
  private child: ChildProcess | undefined;
  private buffer = '';
  private queue: Commit[] = [];
  private ended = false;
  private waiters: (() => void)[] = [];
  private error: string | undefined;

  constructor(
    private readonly root: string,
    args: string[],
  ) {
    const full = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', `--format=${LOG_FORMAT}`, '--decorate=full', ...args];
    log(`[${root}] git ${full.slice(4).join(' ')}`);
    this.child = spawn(getGitPath(), full, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, windowsHide: true });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => {
      this.buffer += d;
      const parts = this.buffer.split('\x01');
      this.buffer = parts.pop() ?? '';
      for (const p of parts) {
        const c = parseLogRecord(root, p);
        if (c) this.queue.push(c);
      }
      if (this.queue.length > 5000) this.child?.stdout?.pause();
      this.wake();
    });
    let stderr = '';
    this.child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    this.child.on('close', code => {
      this.ended = true;
      if (code && code !== 0 && !this.cancelled) this.error = stderr.trim() || vscode.l10n.t('git log exited with {0}', String(code));
      this.wake();
    });
    this.child.on('error', e => {
      this.ended = true;
      this.error = e.message;
      this.wake();
    });
  }

  private cancelled = false;

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach(f => f());
  }

  /** Returns up to `n` more commits; fewer (possibly zero) when the log ended. */
  async next(n: number): Promise<{ commits: Commit[]; done: boolean }> {
    while (this.queue.length < n && !this.ended) {
      this.child?.stdout?.resume();
      await new Promise<void>(r => this.waiters.push(r));
    }
    if (this.error) throw new Error(this.error);
    const commits = this.queue.splice(0, n);
    if (this.queue.length < 5000) this.child?.stdout?.resume();
    return { commits, done: this.ended && this.queue.length === 0 };
  }

  dispose() {
    this.cancelled = true;
    this.child?.kill();
    this.child = undefined;
    this.ended = true;
    this.wake();
  }
}
