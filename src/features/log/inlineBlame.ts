import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { BlameCommit, BlameResult, parseBlamePorcelain } from './annotate';

/**
 * Inline blame, like IntelliJ's "Show Git blame information inline": after the end of the caret line,
 * "author, date, time • commit subject" in a faded italic font. Lines that are not committed show nothing.
 */
export class InlineBlame implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly type = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('ideagittool.inlineBlame.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 3em',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  /** Blame per document, keyed by uri and valid for one document version. */
  private readonly cache = new Map<string, { version: number; result: Promise<BlameResult | undefined> }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: Ctx,
    private readonly annotations: { isAnnotated(uri: vscode.Uri): boolean },
  ) {
    this.disposables.push(
      this.type,
      vscode.window.onDidChangeTextEditorSelection(e => this.schedule(e.textEditor, 150)),
      vscode.window.onDidChangeActiveTextEditor(e => {
        this.clearAll();
        if (e) this.schedule(e, 150);
      }),
      // Edits shift the lines: hide the text until the caret rests again.
      vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
          editor.setDecorations(this.type, []);
          this.schedule(editor, 600);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(d => this.cache.delete(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ideagittool.inlineBlame')) this.refresh();
      }),
      // A commit, checkout or pull changes the blame of open files.
      ctx.repos.onDidChangeRepository(e => {
        if (!e.refs) return;
        this.cache.clear();
        this.refresh();
      }),
    );
    this.refresh();
  }

  private enabled() {
    return vscode.workspace.getConfiguration('ideagittool').get<boolean>('inlineBlame.enabled', true);
  }

  refresh() {
    this.clearAll();
    const editor = vscode.window.activeTextEditor;
    if (editor) this.schedule(editor, 0);
  }

  private clearAll() {
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.type, []);
  }

  private schedule(editor: vscode.TextEditor, delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(editor), delay);
  }

  private async update(editor: vscode.TextEditor) {
    const doc = editor.document;
    if (!this.enabled() || doc.uri.scheme !== 'file' || editor !== vscode.window.activeTextEditor) return;
    // IntelliJ hides inline blame while the gutter annotations are shown.
    if (this.annotations.isAnnotated(doc.uri) || editor.selections.length !== 1) {
      editor.setDecorations(this.type, []);
      return;
    }
    const repo = this.ctx.repos.getForFile(doc.uri.fsPath);
    if (!repo || repo.status.unversioned.some(c => repo.absPath(c.path) === doc.uri.fsPath)) return;
    const line = editor.selection.active.line;
    const version = doc.version;
    const result = await this.blame(repo, doc);
    // The caret or the text may have changed while git ran.
    if (editor !== vscode.window.activeTextEditor || doc.version !== version || editor.selection.active.line !== line) return;
    const commit = result?.lines[line];
    if (!commit) {
      editor.setDecorations(this.type, []);
      return;
    }
    const end = doc.lineAt(line).range.end;
    editor.setDecorations(this.type, [
      {
        range: new vscode.Range(end, end),
        hoverMessage: hover(commit, repo),
        renderOptions: { after: { contentText: inlineText(commit) } },
      },
    ]);
  }

  private blame(repo: Repository, doc: vscode.TextDocument): Promise<BlameResult | undefined> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) return cached.result;
    // The editor text is passed with --contents so that the line numbers match unsaved edits.
    const result = repo
      .exec(['blame', '--porcelain', '--contents', '-', '--', repo.relPath(doc.uri.fsPath)], { input: doc.getText(), allowFailure: true, quiet: true })
      .then(r => (r.exitCode === 0 ? parseBlamePorcelain(r.stdout) : undefined))
      .catch(() => undefined);
    this.cache.set(key, { version: doc.version, result });
    return result;
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}

/** "pengguishen, 2026/4/21, 18:42 • feat: implement …" (date and time in the VS Code display language). */
export function inlineText(c: Pick<BlameCommit, 'author' | 'authorTime' | 'summary'>, locale = (vscode.env?.language ?? 'en')): string {
  const d = new Date(c.authorTime * 1000);
  let date: string;
  let time: string;
  try {
    date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
    time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    date = d.toLocaleDateString();
    time = d.toLocaleTimeString();
  }
  return `${c.author}, ${date}, ${time} • ${c.summary}`;
}

function hover(c: BlameCommit, repo: Repository): vscode.MarkdownString {
  const cmd = (id: string, args: unknown) => `command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendText(c.summary);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(`$(git-commit) \`${c.hash.slice(0, 8)}\` `);
  md.appendText(`${c.author} <${c.authorMail}> on ${new Date(c.authorTime * 1000).toLocaleString((vscode.env?.language ?? 'en'))}`);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(
    [
      `[Show in Git Log](${cmd('ideagittool.log.selectCommit', { root: repo.root, hash: c.hash })})`,
      `[Show Diff](${cmd('ideagittool.showCommitDiff', { root: repo.root, hash: c.hash, path: c.filename })})`,
      `[Show All Affected Files](${cmd('ideagittool.showCommitDiff', { root: repo.root, hash: c.hash })})`,
      `[Copy Revision Number](${cmd('ideagittool.copyText', c.hash)})`,
      `[Annotate with Git Blame](${cmd('ideagittool.annotate', {})})`,
    ].join(' &nbsp;·&nbsp; '),
  );
  return md;
}

export function registerInlineBlame(ctx: Ctx, annotations: { isAnnotated(uri: vscode.Uri): boolean }) {
  const inline = new InlineBlame(ctx, annotations);
  ctx.extension.subscriptions.push(inline);
  ctx.command('ideagittool.inlineBlame.refresh', () => inline.refresh());
  ctx.command('ideagittool.toggleInlineBlame', async () => {
    const cfg = vscode.workspace.getConfiguration('ideagittool');
    await cfg.update('inlineBlame.enabled', !cfg.get<boolean>('inlineBlame.enabled', true), vscode.ConfigurationTarget.Global);
  });
}
