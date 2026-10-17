import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showDialog } from '../../host/dialog';
import { notifySuccess } from '../../host/ui';
import { Change } from '../../shared/types';

export type PatchEntry = Change & { key: string };

export interface PatchRequest {
  files: PatchEntry[];
  selected?: string[];
  /** Default file name without directory. */
  name: string;
  /** Default base path: the paths in the patch are relative to it. */
  basePath: string;
  rootLabel?: string;
  /**
   * Produces the patch for the selected keys. Paths in the result are relative to `basePath`
   * (see rebasePatchPaths for git output relative to a repository root).
   */
  produce(keys: string[], opts: { reverse: boolean; basePath: string }): Promise<string>;
}

const STATE_KEY = 'rebased.createPatch.settings';

let memento: vscode.Memento | undefined;

export function initPatchDialog(m: vscode.Memento) {
  memento = m;
}

/** Shows IntelliJ's Create Patch dialog and writes the patch to a file or the clipboard. */
export async function createPatchDialog(req: PatchRequest): Promise<void> {
  if (!req.files.length) {
    void vscode.window.showInformationMessage('No changes to create a patch from');
    return;
  }
  const saved = memento?.get<{ dir?: string; reverse?: boolean; encoding?: string; toClipboard?: boolean }>(STATE_KEY, {}) ?? {};
  const dir = saved.dir && fs.existsSync(saved.dir) ? saved.dir : req.basePath;
  const fileName = `${req.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'changes'}.patch`;
  await showDialog(
    'commit.createPatch',
    {
      files: req.files,
      selected: req.selected?.length ? req.selected : req.files.map(f => f.key),
      path: path.join(dir, fileName),
      basePath: req.basePath,
      toClipboard: !!saved.toClipboard,
      reverse: !!saved.reverse,
      encoding: saved.encoding ?? 'utf8',
      groupByDirectory: false,
      rootLabel: req.rootLabel,
    },
    {
      title: 'Create Patch',
      handlers: {
        browseFile: async (current: string) => {
          const r = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(current), title: 'Save Patch to', filters: { Patch: ['patch', 'diff'], All: ['*'] } });
          return r?.fsPath ?? null;
        },
        browseDir: async (current: string) => {
          const r = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(current), canSelectFiles: false, canSelectFolders: true, title: 'Select Base Directory for Patch' });
          return r?.[0]?.fsPath ?? null;
        },
      },
      validate: async (v: { keys: string[]; toClipboard: boolean; path: string; basePath: string; reverse: boolean; encoding: BufferEncoding }) => {
        if (!v.toClipboard && !v.path) return 'Specify the patch file';
        if (!v.basePath || !fs.existsSync(v.basePath)) return 'Base path does not exist';
        let text: string;
        try {
          text = await req.produce(v.keys, { reverse: v.reverse, basePath: v.basePath });
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        await memento?.update(STATE_KEY, { dir: v.toClipboard ? saved.dir : path.dirname(v.path), reverse: v.reverse, encoding: v.encoding, toClipboard: v.toClipboard });
        if (v.toClipboard) {
          await vscode.env.clipboard.writeText(text);
          void notifySuccess('Patch copied to clipboard');
          return;
        }
        try {
          fs.mkdirSync(path.dirname(v.path), { recursive: true });
          fs.writeFileSync(v.path, Buffer.from(text, v.encoding));
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        void notifySuccess(`Successfully created patch ${path.basename(v.path)}`, undefined, { label: 'Open', run: () => vscode.window.showTextDocument(vscode.Uri.file(v.path)) });
      },
    },
  );
}

/**
 * Rewrites the paths of a git patch produced in `repoRoot` so that they are relative to `basePath`.
 * Files outside of the base path keep a `../` relative path.
 */
export function rebasePatchPaths(patch: string, repoRoot: string, basePath: string): string {
  const rel = path.relative(path.resolve(basePath), path.resolve(repoRoot)).replace(/\\/g, '/');
  if (!rel) return patch;
  const fix = (p: string) => path.posix.normalize(`${rel}/${p}`);
  return patch
    .split('\n')
    .map(line => {
      let m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) return `diff --git a/${fix(m[1])} b/${fix(m[2])}`;
      m = /^(---|\+\+\+) ([ab])\/(.*)$/.exec(line);
      if (m) return `${m[1]} ${m[2]}/${fix(m[3])}`;
      m = /^(rename|copy) (from|to) (.*)$/.exec(line);
      if (m) return `${m[1]} ${m[2]} ${fix(m[3])}`;
      return line;
    })
    .join('\n');
}

/** Reverses a text patch (swaps old and new). Binary sections are kept as they are. */
export function reversePatch(patch: string): string {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    let m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) {
      out.push(`diff --git a/${m[2]} b/${m[1]}`);
      continue;
    }
    if (line.startsWith('--- ')) {
      out.push(`+++ ${line.slice(4).replace(/^a\//, 'b/')}`);
      continue;
    }
    if (line.startsWith('+++ ')) {
      // Keep "--- " before "+++ ": swap with the previous line.
      const prev = out.pop()!;
      out.push(`--- ${line.slice(4).replace(/^b\//, 'a/')}`, prev);
      continue;
    }
    if (line.startsWith('new file mode')) {
      out.push(line.replace('new file mode', 'deleted file mode'));
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      out.push(line.replace('deleted file mode', 'new file mode'));
      continue;
    }
    m = /^(rename|copy) from (.*)$/.exec(line);
    if (m) {
      out.push(`${m[1]} to ${m[2]}`);
      continue;
    }
    m = /^(rename|copy) to (.*)$/.exec(line);
    if (m) {
      // "rename from" must come first.
      const prev = out.pop()!;
      out.push(`${m[1]} from ${m[2]}`, prev);
      continue;
    }
    m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(.*)$/.exec(line);
    if (m) {
      out.push(`index ${m[2]}..${m[1]}${m[3]}`);
      continue;
    }
    m = /^@@ -(\S+) \+(\S+) @@(.*)$/.exec(line);
    if (m) {
      out.push(`@@ -${m[2]} +${m[1]} @@${m[3]}`);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) out.push('-' + line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) out.push('+' + line.slice(1));
    else out.push(line);
  }
  return out.join('\n');
}
