import * as vscode from 'vscode';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { fromGitUri, GIT_SCHEME } from '../../host/gitContent';
import { themeData } from '../../host/webviewHost';

export interface BlameCommit {
  hash: string;
  author: string;
  authorMail: string;
  authorTime: number;
  committer: string;
  committerTime: number;
  summary: string;
  previous?: { hash: string; path: string };
  filename: string;
}

export interface BlameResult {
  lines: (BlameCommit | undefined)[];
  commits: Map<string, BlameCommit>;
}

const ZERO = '0000000000000000000000000000000000000000';

export function parseBlamePorcelain(out: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: (BlameCommit | undefined)[] = [];
  const rows = out.split('\n');
  let cur: BlameCommit | undefined;
  let finalLine = 0;
  for (const row of rows) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(row);
    if (header) {
      const hash = header[1];
      finalLine = +header[3];
      cur = commits.get(hash);
      if (!cur) {
        cur = { hash, author: '', authorMail: '', authorTime: 0, committer: '', committerTime: 0, summary: '', filename: '' };
        commits.set(hash, cur);
      }
      continue;
    }
    if (!cur) continue;
    if (row.startsWith('\t')) {
      lines[finalLine - 1] = cur.hash === ZERO ? undefined : cur;
      continue;
    }
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const val = sp < 0 ? '' : row.slice(sp + 1);
    switch (key) {
      case 'author':
        cur.author = val;
        break;
      case 'author-mail':
        cur.authorMail = val.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        cur.authorTime = +val;
        break;
      case 'committer':
        cur.committer = val;
        break;
      case 'committer-time':
        cur.committerTime = +val;
        break;
      case 'summary':
        cur.summary = val;
        break;
      case 'previous': {
        const [h, ...p] = val.split(' ');
        cur.previous = { hash: h, path: p.join(' ') };
        break;
      }
      case 'filename':
        cur.filename = val;
        break;
    }
  }
  return { lines, commits };
}

/** IntelliJ's annotation date format: short date, e.g. 16/06/2026. */
function shortDate(t: number) {
  const d = new Date(t * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

interface AnnotateOptions {
  showRevision: boolean;
  showDate: boolean;
  showAuthor: boolean;
  names: 'full' | 'first' | 'last' | 'initials' | 'email';
  colors: 'order' | 'author' | 'hide';
  ignoreWhitespace: boolean;
  detectMovementsWithinFile: boolean;
  detectMovementsAcrossFiles: boolean;
  preferCommitDate: boolean;
}

function options(): AnnotateOptions {
  const c = vscode.workspace.getConfiguration('ideagittool.annotate');
  return {
    showRevision: c.get('showRevision', false),
    showDate: c.get('showDate', true),
    showAuthor: c.get('showAuthor', true),
    names: c.get('names', 'first'),
    colors: c.get('colors', 'order'),
    ignoreWhitespace: c.get('ignoreWhitespace', false),
    detectMovementsWithinFile: c.get('detectMovementsWithinFile', false),
    detectMovementsAcrossFiles: c.get('detectMovementsAcrossFiles', false),
    preferCommitDate: c.get('preferCommitDate', false),
  };
}

function formatName(author: string, mail: string, style: AnnotateOptions['names']) {
  const parts = author.trim().split(/\s+/);
  let n: string;
  switch (style) {
    case 'full':
      n = author;
      break;
    case 'last':
      n = parts[parts.length - 1];
      break;
    case 'initials':
      n = parts.map(p => p[0]?.toUpperCase() ?? '').join('');
      break;
    case 'email':
      n = mail;
      break;
    default:
      n = parts[0];
  }
  return n.length > 16 ? n.slice(0, 15) + '…' : n;
}

function annotationText(c: BlameCommit, o: AnnotateOptions) {
  const parts: string[] = [];
  if (o.showRevision) parts.push(c.hash.slice(0, 8));
  if (o.showDate) parts.push(shortDate(o.preferCommitDate ? c.committerTime : c.authorTime));
  if (o.showAuthor) parts.push(formatName(c.author, c.authorMail, o.names));
  return parts.join('  ');
}

function annotationWidth(o: AnnotateOptions) {
  return (o.showRevision ? 10 : 0) + (o.showDate ? 12 : 0) + (o.showAuthor ? (o.names === 'full' || o.names === 'email' ? 18 : 14) : 0);
}

const BUCKETS = 8;

/**
 * "Annotate with Git Blame": per-line author/date shown before the code, background colored by age
 * (newer commits are more saturated, like IntelliJ's AnnotationsSettings color by age).
 */
class AnnotationController implements vscode.Disposable {
  private readonly annotated = new Map<string, { repo: Repository; path: string; rev?: string; result?: BlameResult }>();
  private types: vscode.TextEditorDecorationType[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ctx: Ctx) {
    this.createTypes();
    vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll(), null, this.disposables);
    vscode.window.onDidChangeActiveTextEditor(() => this.updateContext(), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument(e => this.onEdit(e.document), null, this.disposables);
    vscode.workspace.onDidCloseTextDocument(d => this.annotated.delete(d.uri.toString()), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('ideagittool.annotate')) return;
      this.createTypes();
      for (const key of this.annotated.keys()) void this.load(key);
    }, null, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => {
      this.createTypes();
      this.renderAll();
    }, null, this.disposables);
    ctx.repos.onDidChangeRepository(e => {
      if (!e.refs) return;
      for (const [key, a] of this.annotated) if (a.repo === e.repo) void this.load(key);
    }, null, this.disposables);
  }

  private createTypes() {
    this.types.forEach(t => t.dispose());
    const dark = themeData().dark;
    this.types = [];
    for (let i = 0; i < BUCKETS; i++) {
      // Bucket 0 = newest. Blend the annotation background from strong to transparent.
      const alpha = options().colors === 'hide' ? 0 : 0.32 - (i * 0.3) / (BUCKETS - 1);
      const bg = dark ? `rgba(87, 150, 92, ${alpha.toFixed(2)})` : `rgba(32, 138, 60, ${(alpha * 0.7).toFixed(2)})`;
      this.types.push(
        vscode.window.createTextEditorDecorationType({
          before: {
            backgroundColor: bg,
            color: new vscode.ThemeColor('editorLineNumber.foreground'),
            margin: '0 12px 0 0',
            width: `${annotationWidth(options())}ch`,
          },
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
    }
    this.types.push(
      vscode.window.createTextEditorDecorationType({
        before: { margin: '0 12px 0 0', width: `${annotationWidth(options())}ch`, contentText: '' },
      }),
    );
  }

  isAnnotated(uri: vscode.Uri) {
    return this.annotated.has(uri.toString());
  }

  async toggle(editor: vscode.TextEditor) {
    const key = editor.document.uri.toString();
    if (this.annotated.has(key)) {
      this.annotated.delete(key);
      this.clear(editor);
      this.updateContext();
      return;
    }
    const target = this.resolve(editor.document.uri);
    if (!target) {
      void vscode.window.showWarningMessage('The file is not under Git version control.');
      return;
    }
    this.annotated.set(key, target);
    await this.load(key);
    this.updateContext();
  }

  private resolve(uri: vscode.Uri): { repo: Repository; path: string; rev?: string } | undefined {
    if (uri.scheme === GIT_SCHEME) {
      const q = fromGitUri(uri);
      const repo = this.ctx.repos.get(q.root);
      return repo && /^[0-9a-f]{7,40}$/.test(q.ref) ? { repo, path: q.path, rev: q.ref } : undefined;
    }
    if (uri.scheme !== 'file') return undefined;
    const repo = this.ctx.repos.getForFile(uri.fsPath);
    return repo ? { repo, path: repo.relPath(uri.fsPath) } : undefined;
  }

  private async load(key: string) {
    const a = this.annotated.get(key);
    if (!a) return;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
    const o = options();
    const args = ['blame', '--porcelain'];
    if (o.ignoreWhitespace) args.push('-w');
    if (o.detectMovementsWithinFile) args.push('-M');
    if (o.detectMovementsAcrossFiles) args.push('-C');
    let input: string | undefined;
    if (a.rev) args.push(a.rev);
    else if (doc) {
      args.push('--contents', '-');
      input = doc.getText();
    }
    args.push('--', a.path);
    const r = await a.repo.exec(args, { input, allowFailure: true, quiet: true });
    if (r.exitCode !== 0) {
      this.annotated.delete(key);
      void vscode.window.showErrorMessage(`Cannot annotate ${a.path}: ${r.stderr.trim()}`);
      this.updateContext();
      return;
    }
    a.result = parseBlamePorcelain(r.stdout);
    this.renderAll();
  }

  private onEdit(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    if (!this.annotated.has(key)) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.load(key), 600));
  }

  private renderAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      const a = this.annotated.get(editor.document.uri.toString());
      if (a?.result) this.render(editor, a.result, a.repo);
      else this.clear(editor);
    }
  }

  private clear(editor: vscode.TextEditor) {
    this.types.forEach(t => editor.setDecorations(t, []));
  }

  private render(editor: vscode.TextEditor, result: BlameResult, repo: Repository) {
    const o = options();
    const commits = [...result.commits.values()].filter(c => c.hash !== ZERO);
    const times = [...new Set(commits.map(c => c.authorTime))].sort((x, y) => y - x);
    const rank = new Map(times.map((t, i) => [t, times.length <= 1 ? 0 : Math.floor((i * BUCKETS) / times.length)]));
    // Colors by author: each author gets a stable bucket.
    const authors = [...new Set(commits.map(c => c.author))];
    const bucketOf = (c: BlameCommit) => (o.colors === 'author' ? (authors.indexOf(c.author) * 3) % BUCKETS : (rank.get(c.authorTime) ?? BUCKETS - 1));
    const perType: vscode.DecorationOptions[][] = this.types.map(() => []);
    const hovers = new Map<string, vscode.MarkdownString>();
    for (let i = 0; i < editor.document.lineCount; i++) {
      const c = result.lines[i];
      const range = new vscode.Range(i, 0, i, 0);
      if (!c) {
        perType[BUCKETS].push({ range, renderOptions: { before: { contentText: ' ' } } });
        continue;
      }
      let hover = hovers.get(c.hash);
      if (!hover) {
        hover = this.hover(c, repo);
        hovers.set(c.hash, hover);
      }
      const text = annotationText(c, o);
      perType[bucketOf(c)].push({ range, hoverMessage: hover, renderOptions: { before: { contentText: text.replace(/ /g, ' ') } } });
    }
    this.types.forEach((t, i) => editor.setDecorations(t, perType[i]));
  }

  private hover(c: BlameCommit, repo: Repository): vscode.MarkdownString {
    const cmd = (id: string, args: unknown) => `command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
    const date = new Date(c.authorTime * 1000).toLocaleString();
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**${escapeMd(c.summary)}**\n\n`);
    md.appendMarkdown(`$(git-commit) \`${c.hash.slice(0, 8)}\` ${escapeMd(c.author)} <${escapeMd(c.authorMail)}> on ${date}\n\n`);
    md.appendMarkdown(
      [
        `[Show in Git Log](${cmd('ideagittool.log.selectCommit', { root: repo.root, hash: c.hash })})`,
        `[Show Diff](${cmd('ideagittool.showCommitDiff', { root: repo.root, hash: c.hash, path: c.filename })})`,
        `[Show All Affected Files](${cmd('ideagittool.showCommitDiff', { root: repo.root, hash: c.hash })})`,
        c.previous ? `[Annotate Previous Revision](${cmd('ideagittool.annotateRevision', { root: repo.root, hash: c.previous.hash, path: c.previous.path })})` : '',
        `[Copy Revision Number](${cmd('ideagittool.copyText', c.hash)})`,
        `[Show in File History](${cmd('ideagittool.showFileHistory', { root: repo.root, path: c.filename })})`,
        `[View Options…](${cmd('ideagittool.annotateOptions', {})})`,
        `[Close Annotations](${cmd('ideagittool.annotateClose', {})})`,
      ]
        .filter(Boolean)
        .join(' &nbsp;·&nbsp; '),
    );
    return md;
  }

  updateContext() {
    const e = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'ideagittool.annotated', !!e && this.annotated.has(e.document.uri.toString()));
    // Inline blame is hidden while annotations are shown.
    void vscode.commands.executeCommand('ideagittool.inlineBlame.refresh').then(undefined, () => undefined);
  }

  async annotateRevision(root: string, hash: string, rel: string) {
    const { toGitUri } = await import('../../host/gitContent');
    const uri = toGitUri(root, rel, hash);
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    if (!this.isAnnotated(uri)) await this.toggle(editor);
  }

  dispose() {
    this.types.forEach(t => t.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, m => `\\${m}`);
}

export function registerAnnotate(ctx: Ctx): { isAnnotated(uri: vscode.Uri): boolean } {
  const controller = new AnnotationController(ctx);
  ctx.extension.subscriptions.push(controller);
  ctx.command('ideagittool.annotate', async (uri?: vscode.Uri) => {
    let editor = vscode.window.activeTextEditor;
    if (uri instanceof vscode.Uri && editor?.document.uri.toString() !== uri.toString()) editor = await vscode.window.showTextDocument(uri);
    if (editor) await controller.toggle(editor);
  });
  ctx.command('ideagittool.annotateClose', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && controller.isAnnotated(editor.document.uri)) await controller.toggle(editor);
  });
  ctx.command('ideagittool.annotateRevision', (a: { root: string; hash: string; path: string }) => controller.annotateRevision(a.root, a.hash, a.path));
  ctx.command('ideagittool.annotateOptions', async () => {
    const c = vscode.workspace.getConfiguration('ideagittool.annotate');
    const o = options();
    type Item = vscode.QuickPickItem & { key?: string; value?: unknown };
    const toggle = (label: string, key: keyof AnnotateOptions): Item => ({ label: `${o[key] ? '$(check)' : '$(blank)'} ${label}`, key, value: !o[key] });
    const radio = (label: string, key: keyof AnnotateOptions, value: string): Item => ({ label: `${o[key] === value ? '$(circle-filled)' : '$(blank)'} ${label}`, key, value });
    const items: Item[] = [
      { label: 'View', kind: vscode.QuickPickItemKind.Separator },
      toggle('Author', 'showAuthor'),
      toggle('Date', 'showDate'),
      toggle('Revision', 'showRevision'),
      toggle('Show Commit Timestamp', 'preferCommitDate'),
      { label: 'Colors', kind: vscode.QuickPickItemKind.Separator },
      radio('Hide', 'colors', 'hide'),
      radio('Author', 'colors', 'author'),
      radio('Order', 'colors', 'order'),
      { label: 'Names', kind: vscode.QuickPickItemKind.Separator },
      radio('Full Name', 'names', 'full'),
      radio('First Name', 'names', 'first'),
      radio('Last Name', 'names', 'last'),
      radio('Initials', 'names', 'initials'),
      radio('Email', 'names', 'email'),
      { label: 'Options', kind: vscode.QuickPickItemKind.Separator },
      toggle('Ignore Whitespaces', 'ignoreWhitespace'),
      toggle('Detect Movements Within File', 'detectMovementsWithinFile'),
      toggle('Detect Movements Across Files', 'detectMovementsAcrossFiles'),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Annotations' });
    if (picked?.key) await c.update(picked.key, picked.value, vscode.ConfigurationTarget.Global);
  });
  ctx.command('ideagittool.copyText', (text: string) => vscode.env.clipboard.writeText(text));
  return controller;
}
