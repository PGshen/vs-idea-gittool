// Pure logic for AI-generated commit messages: request building, Server-Sent Events parsing and answer
// cleanup. Kept free of vscode imports so it runs under node:test (see scripts/test.mjs).

export type AiProvider = 'openai' | 'anthropic';

export interface AiRequestConfig {
  provider: AiProvider;
  /** '' = the provider's official endpoint. */
  baseUrl: string;
  model: string;
  /** Undefined/'' = send no auth headers (internal gateways without authentication). */
  apiKey?: string;
}

const OFFICIAL_BASE: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/** The chat endpoint of the configured provider; the base may be a custom gateway. */
export function chatEndpoint(cfg: AiRequestConfig): string {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '') || OFFICIAL_BASE[cfg.provider];
  return cfg.provider === 'openai' ? `${base}/chat/completions` : `${base}/v1/messages`;
}

export function chatHeaders(cfg: AiRequestConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const key = cfg.apiKey?.trim();
  if (cfg.provider === 'openai') {
    if (key) headers.Authorization = `Bearer ${key}`;
  } else {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  }
  return headers;
}

export function chatBody(cfg: AiRequestConfig, system: string, user: string): string {
  if (cfg.provider === 'openai') {
    return JSON.stringify({
      model: cfg.model,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
  }
  // stream_options is deliberately omitted: Ollama and several gateways reject it. max_tokens is required
  // by the Messages API.
  return JSON.stringify({
    model: cfg.model,
    stream: true,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
}

/** Yields the joined `data:` payload of each Server-Sent Event frame of a streamed response body. */
export async function* sseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const feed = (line: string) => {
    // event:/id: lines are ignored: both providers carry everything the answer needs in the data JSON.
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (data.length) {
          const payload = data.join('\n');
          data = [];
          yield payload;
        }
      } else {
        feed(line);
      }
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer) feed(buffer.replace(/\r$/, ''));
  if (data.length) yield data.join('\n');
}

/** What a stream frame carries: a text piece, the end of the answer, or nothing (keep-alives, roles). */
export type StreamText = string | 'done' | undefined;

export function openaiText(frameData: string): StreamText {
  if (frameData === '[DONE]') return 'done';
  let j: any;
  try {
    j = JSON.parse(frameData);
  } catch {
    return undefined;
  }
  if (j?.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  const piece: string | undefined = j?.choices?.[0]?.delta?.content;
  return piece || undefined;
}

export function anthropicText(frameData: string): StreamText {
  let j: any;
  try {
    j = JSON.parse(frameData);
  } catch {
    return undefined;
  }
  if (j?.type === 'error') throw new Error(j.error?.message ?? JSON.stringify(j.error));
  if (j?.type === 'message_stop') return 'done';
  if (j?.type === 'content_block_delta' && j.delta?.type === 'text_delta') return j.delta.text || undefined;
  return undefined;
}

/** Caps the diff at maxChars code points without splitting one; marks the cut so the model knows. */
export function truncateDiff(diff: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars > 0) {
    const chars = Array.from(diff);
    if (chars.length > maxChars) return { text: chars.slice(0, maxChars).join('') + '\n...[diff truncated]', truncated: true };
  }
  return { text: diff, truncated: false };
}

export const DEFAULT_COMMIT_INSTRUCTIONS = [
  'You are a git commit message writer. Analyze the following changes and write a commit message.',
  '',
  'Rules:',
  '- Write the commit message in this language: {language}',
  '- First line: imperative mood, max 72 characters (e.g. "Add user authentication")',
  '- Leave a blank line after the first line',
  '- Body: 2-4 bullet points explaining WHAT changed and WHY, each starting with "- "',
  '- Be specific and technical, reference file names or module names when relevant',
  '- Match the style of the repository\'s recent commit messages when they are included below',
  '- Output ONLY the commit message, no explanations, no markdown fences',
].join('\n');

/** A custom prompt replaces the built-in instructions; the caller always appends the context after them. */
export function buildInstructions(custom: string | undefined, language: string): string {
  return (custom?.trim() || DEFAULT_COMMIT_INSTRUCTIONS).replace(/\{language\}/g, language);
}

/** Non-empty context sections joined with blank lines, so a custom prompt can never lose the data. */
export function buildContext(sections: Array<string | undefined | false>): string {
  return sections.filter((s): s is string => !!s && !!s.trim()).join('\n\n');
}

/** Strips what models wrap a whole answer in despite being told not to: a code fence, quotes around a one-liner. */
export function cleanCommitMessage(raw: string): string {
  let t = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^\s*(```|~~~)[\w-]*\n([\s\S]*?)\n\s*\1$/.exec(t);
  if (fenced) t = fenced[2].trim();
  if (!t.includes('\n')) t = t.replace(/^(["'`])(.*)\1$/, '$2').trim();
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

/** The same cleanup for text still being streamed: only the opening of a fence can be recognized yet. */
export function cleanPartialCommitMessage(raw: string): string {
  return raw.replace(/^\s*(```|~~~)[\w-]*\n/, '').trimStart();
}
