import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { log } from '../host/output';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface ExecOptions {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  token?: vscode.CancellationToken;
  /** Do not throw on non-zero exit code. */
  allowFailure?: boolean;
  /** Return raw Buffer stdout (for binary content). */
  binary?: boolean;
  /** Called for each stderr line, used to report progress of fetch/push/clone. */
  onStderrLine?: (line: string) => void;
  /** Do not write the command to the Git console. */
  quiet?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  buffer?: Buffer;
}

let gitPath = 'git';

export function setGitPath(path: string | undefined) {
  gitPath = path && path.trim() ? path : 'git';
}

export function getGitPath() {
  return gitPath;
}

/**
 * Runs a git command. Every command is mirrored in the "Git" output channel, like the Git console in IntelliJ.
 */
export function git(args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (!opts.quiet) log(`[${opts.cwd}] git ${args.map(quoteArg).join(' ')}`);
    const child = spawn(gitPath, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', ...opts.env },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let errLine = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err.push(d);
      if (opts.onStderrLine) {
        errLine += d.toString('utf8');
        const parts = errLine.split(/[\r\n]/);
        errLine = parts.pop() ?? '';
        for (const p of parts) if (p.trim()) opts.onStderrLine(p);
      }
    });
    const sub = opts.token?.onCancellationRequested(() => child.kill());
    child.on('error', e => {
      sub?.dispose();
      reject(new GitError(`Cannot run git: ${e.message}`, args, null, '', String(e)));
    });
    child.on('close', code => {
      sub?.dispose();
      const buffer = Buffer.concat(out);
      const stdout = opts.binary ? '' : buffer.toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (!opts.quiet && Date.now() - started > 1000) log(`  (${Date.now() - started} ms)`);
      if (code !== 0 && !opts.allowFailure) {
        if (!opts.quiet) log(stderr.trim());
        reject(new GitError(stderr.trim() || stdout.trim() || `git ${args[0]} failed with exit code ${code}`, args, code, stdout, stderr));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 0, buffer: opts.binary ? buffer : undefined });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function quoteArg(a: string) {
  return /[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a;
}

/** Splits NUL-separated output, dropping the trailing empty element. */
export function splitNul(s: string): string[] {
  const parts = s.split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
