import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { Ctx } from '../../context';
import { Repository } from '../../git/repository';
import { input, notifySuccess, notifyWarning, withProgress } from '../../host/ui';
import { Change } from '../../shared/types';
import {
  AiProvider,
  anthropicText,
  buildContext,
  buildInstructions,
  chatBody,
  chatEndpoint,
  chatHeaders,
  cleanCommitMessage,
  cleanPartialCommitMessage,
  openaiText,
  sseStream,
  truncateDiff,
} from './aiEngine';
import { createPatch } from './gitOps';

/** The structured outcome posted as the aiEnd event and returned by the aiGenerate RPC. */
export interface AiResult {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  error?: string;
}

const SECRET_PREFIX = 'ideagittool.ai.apiKey.';

interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  prompt: string;
  language: string;
  maxDiffChars: number;
}

function aiSettings(): AiSettings {
  const cfg = vscode.workspace.getConfiguration('ideagittool.ai');
  return {
    provider: cfg.get<AiProvider>('provider', 'openai'),
    baseUrl: cfg.get('baseUrl', '').trim(),
    model: cfg.get('model', '').trim(),
    prompt: cfg.get('prompt', ''),
    language: cfg.get('language', '').trim() || vscode.env.language || 'en',
    maxDiffChars: cfg.get('maxDiffChars', 8000),
  };
}

/** The provider's key from SecretStorage, undefined when none is stored (internal gateways need none). */
async function apiKey(ctx: Ctx, provider: AiProvider): Promise<string | undefined> {
  const stored = await ctx.extension.secrets.get(`${SECRET_PREFIX}${provider}`);
  return stored?.trim() || undefined;
}

function providerLabel(provider: AiProvider): string {
  return provider === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible API';
}

/** "IdeaGitTool: Set API Key for AI Commit Messages…": picks the provider, then a hidden input. */
export async function setApiKeyCommand(ctx: Ctx): Promise<void> {
  const current = vscode.workspace.getConfiguration('ideagittool.ai').get<AiProvider>('provider', 'openai');
  const items = (['openai', 'anthropic'] as AiProvider[]).map(p => ({
    label: providerLabel(p),
    description: `${SECRET_PREFIX}${p}`,
    detail: p === current ? translate('(current provider)') : undefined,
    provider: p,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: translate('API key for which provider?') });
  if (!picked) return;
  const key = await input({
    password: true,
    prompt: translate('API key for {0}', providerLabel(picked.provider)),
    placeHolder: translate('Empty to send no API key (for internal gateways)'),
  });
  if (key.trim()) await ctx.extension.secrets.store(`${SECRET_PREFIX}${picked.provider}`, key.trim());
  else await ctx.extension.secrets.delete(`${SECRET_PREFIX}${picked.provider}`);
  void notifySuccess(key.trim() ? translate('API key stored.') : translate('API key removed.'));
}

/**
 * Generates a commit message with the configured AI provider and streams it into the Commit tool window's
 * message box (events aiStart / aiProgress / aiEnd on the commit view's connection). Never throws: known
 * problems come back as AiResult and a notification, so the webview host does not double-report them.
 */
export class AiCommitAssistant {
  private running = false;

  constructor(
    private ctx: Ctx,
    private post: (name: string, data?: unknown) => void,
    private changesOf: (keys: string[]) => Change[],
    private byRepo: (changes: Change[]) => [Repository, Change[]][],
  ) {}

  async generate(keys: string[]): Promise<AiResult> {
    if (this.running) return { status: 'error', error: 'busy' };
    this.running = true;
    try {
      const s = aiSettings();
      // Validation failures never enter the streaming state: no ai events, the message box is left alone.
      if (!s.model) {
        void notifyWarning(
          translate('AI model is not configured'),
          translate('Set the model in IdeaGitTool settings (ideagittool.ai.model) to generate commit messages with AI.'),
          { label: translate('Open Settings'), run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'ideagittool.ai') },
          { label: translate('Set API Key'), run: () => void setApiKeyCommand(this.ctx) },
        );
        return { status: 'error', error: 'AI model is not configured' };
      }
      const changes = this.changesOf(keys);
      if (!changes.length) {
        void notifyWarning(translate('No files to commit: select some changes to generate a commit message from'));
        return { status: 'error', error: 'no changes' };
      }
      const result = await withProgress(translate('Generating Commit Message…'), async (_progress, token) => {
        this.post('aiStart');
        const label = providerLabel(s.provider);
        const user = await this.promptContext(this.byRepo(changes), s);
        const system = buildInstructions(s.prompt, s.language);
        const cfg = { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: await apiKey(this.ctx, s.provider) };
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        const res = await fetch(chatEndpoint(cfg), { method: 'POST', headers: chatHeaders(cfg), body: chatBody(cfg, system, user), signal: controller.signal });
        if (!res.ok) throw new Error(translate('{0} error {1}: {2}', label, res.status, (await res.text()).slice(0, 300)));
        if (!res.body) throw new Error(translate('{0} returned an empty response', label));
        let full = '';
        let last = 0;
        for await (const frame of sseStream(res.body)) {
          const piece = s.provider === 'openai' ? openaiText(frame) : anthropicText(frame);
          if (piece === 'done') break;
          if (!piece) continue;
          full += piece;
          const now = Date.now();
          if (now - last >= 100) {
            last = now;
            this.post('aiProgress', cleanPartialCommitMessage(full));
          }
        }
        const message = cleanCommitMessage(full);
        if (!message) throw new Error(translate('{0} returned an empty response', label));
        return { status: 'done' as const, message };
      });
      this.post('aiEnd', result);
      return result;
    } catch (e) {
      const result: AiResult =
        e instanceof Error && e.name === 'AbortError' ? { status: 'cancelled' } : { status: 'error', error: e instanceof Error ? e.message : String(e) };
      this.post('aiEnd', result);
      if (result.status === 'error') {
        void notifyWarning(
          translate('AI request failed: {0}', result.error ?? ''),
          undefined,
          { label: translate('Open Settings'), run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'ideagittool.ai') },
          { label: translate('Set API Key'), run: () => void setApiKeyCommand(this.ctx) },
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Instructions context: recent subjects for style, then per repository the changed files and the diff. */
  private async promptContext(groups: [Repository, Change[]][], s: AiSettings): Promise<string> {
    const multi = groups.length > 1;
    const sections: Array<string | undefined> = [];
    let subjects: string[] = [];
    for (const [repo, list] of groups) {
      const { patch, files } = await createPatch(repo, list, { binary: false });
      const fileLines = files
        .slice(0, 50)
        .map(f => `${f.status} ${f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}`)
        .join('\n');
      const diff = truncateDiff(patch, s.maxDiffChars);
      sections.push(buildContext([
        multi ? `### Repository: ${repo.name}` : '',
        `## Changed files\n${fileLines}`,
        diff.text ? `## Diff\n\`\`\`diff\n${diff.text}\n\`\`\`` : '',
      ]));
      if (!subjects.length && !repo.info.empty) {
        const log = await repo.execText(['log', '-n', '5', '--pretty=format:%s'], { quiet: true, allowFailure: true });
        subjects = log.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 10);
      }
    }
    return buildContext([
      subjects.length ? `## Recent commit messages in this repository\n${subjects.map(x => `- ${x}`).join('\n')}` : '',
      ...sections,
    ]);
  }
}
