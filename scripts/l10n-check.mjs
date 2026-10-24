// Checks the UI text translations: every string passed to vscode.l10n.t() (host) or t() (webviews, src/webview/lib/l10n.ts)
// must be a plain string literal with a translation in l10n/bundle.l10n.<language>.json, with the same {n} placeholders.
// Usage: npm run l10n -- [--merge] [--strict]
//   --merge   merges l10n/parts/*.json (partial translations) into the bundles, then deletes the parts
//   --strict  exits with 1 when a translation is missing or a call does not use a literal
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LANGS = ['zh-cn'];
const strict = process.argv.includes('--strict');

function files(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

// vscode.l10n.t('...') anywhere; t('...') in files that import t from webview/lib/l10n or Translate from shared/l10n.
const L10N_CALL = /\bl10n\.t\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|(`))/g;
const T_CALL = /(?<![\w$.])t\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|(`))/g;
const IMPORTS_T = /import\s*(?:type\s*)?\{[^}]*\b(?:t|Translate)\b[^}]*\}\s*from\s*'[^']*\/l10n'/;
// Value of a string literal of our own sources.
const literal = (raw, quote) => new Function(`return ${quote}${raw}${quote}`)();

const keys = new Map(); // message -> first location
const problems = [];
for (const f of files('src')) {
  const text = readFileSync(f, 'utf8');
  for (const m of [...text.matchAll(L10N_CALL), ...(IMPORTS_T.test(text) ? text.matchAll(T_CALL) : [])]) {
    const line = text.slice(0, m.index).split('\n').length;
    if (m[3]) {
      problems.push(`${f}:${line}: template literal in t(); use t('... {0} ...', value)`);
      continue;
    }
    const msg = m[1] !== undefined ? literal(m[1], "'") : literal(m[2], '"');
    if (!keys.has(msg)) keys.set(msg, `${f}:${line}`);
  }
}

const placeholders = s => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',');
const merging = process.argv.includes('--merge');
for (const lang of LANGS) {
  const bundlePath = `l10n/bundle.l10n.${lang}.json`;
  let bundle = existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : {};
  // Without --merge the parts only count as translations; nothing is written.
  if (existsSync('l10n/parts')) {
    for (const p of readdirSync('l10n/parts').filter(p => p.endsWith('.json')).sort()) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(`l10n/parts/${p}`, 'utf8')))) {
        if (k in bundle && bundle[k] !== v) console.log(`conflict (${p}): "${k}": kept "${bundle[k]}", dropped "${v}"`);
        else bundle[k] = v;
      }
    }
    if (merging) rmSync('l10n/parts', { recursive: true });
  }
  const unused = Object.keys(bundle).filter(k => !keys.has(k));
  if (merging) {
    // Keep only used keys, in source order.
    const sorted = {};
    for (const k of keys.keys()) if (k in bundle) sorted[k] = bundle[k];
    bundle = sorted;
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
  }

  const missing = [...keys.keys()].filter(k => !(k in bundle));
  for (const k of missing) problems.push(`${keys.get(k)}: no ${lang} translation for "${k}"`);
  for (const [k, v] of Object.entries(bundle)) if (keys.has(k) && placeholders(k) !== placeholders(v)) problems.push(`${keys.get(k)}: ${lang} placeholders differ: "${k}" -> "${v}"`);
  console.log(`${lang}: ${keys.size} strings, ${missing.length} missing, ${unused.length} unused${merging ? ' removed' : ''}`);
}
problems.forEach(p => console.log(p));
if (strict && problems.length) process.exit(1);
