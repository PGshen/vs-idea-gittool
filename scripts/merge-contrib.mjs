// Merges contrib/*.json fragments into package.json "contributes".
// Arrays are concatenated, objects are merged recursively.
// The UI text of the contributions is replaced by %key% placeholders. The English text (from contrib/) goes to
// package.nls.json; translations are kept in package.nls.<language>.json, and keys missing there are reported.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

/** Text that stays the same in every language. */
const UNTRANSLATED = new Set(['IdeaGitTool', 'Git']);
const id = s => s.replace(/^ideagittool\./, '');

function localize(c) {
  const nls = {};
  const put = (obj, field, key) => {
    const v = obj?.[field];
    if (typeof v !== 'string' || UNTRANSLATED.has(v)) return;
    nls[key] = v;
    obj[field] = `%${key}%`;
  };
  for (const cmd of c.commands ?? []) {
    put(cmd, 'title', `command.${id(cmd.command)}.title`);
    put(cmd, 'shortTitle', `command.${id(cmd.command)}.shortTitle`);
    if (cmd.category && !UNTRANSLATED.has(cmd.category)) put(cmd, 'category', `category.${cmd.category.replace(/\W+/g, '')}`);
  }
  for (const conf of [c.configuration ?? []].flat()) {
    put(conf, 'title', 'configuration.title');
    for (const [name, p] of Object.entries(conf.properties ?? {})) {
      const k = `config.${id(name)}`;
      put(p, 'description', `${k}.description`);
      put(p, 'markdownDescription', `${k}.markdownDescription`);
      put(p, 'deprecationMessage', `${k}.deprecationMessage`);
      for (const f of ['enumDescriptions', 'markdownEnumDescriptions']) p[f]?.forEach((_, i) => put(p[f], i, `${k}.${f}.${i}`));
    }
  }
  for (const list of Object.values(c.viewsContainers ?? {})) for (const v of list) put(v, 'title', `viewContainer.${id(v.id)}.title`);
  for (const list of Object.values(c.views ?? {}))
    for (const v of list) {
      put(v, 'name', `view.${id(v.id)}.name`);
      put(v, 'contextualTitle', `view.${id(v.id)}.contextualTitle`);
    }
  for (const s of c.submenus ?? []) put(s, 'label', `submenu.${id(s.id)}.label`);
  for (const w of c.viewsWelcome ?? []) put(w, 'contents', `viewsWelcome.${id(w.view)}.contents`);
  for (const col of c.colors ?? []) put(col, 'description', `color.${id(col.id)}.description`);
  return nls;
}

let contributes = {};
for (const f of readdirSync('contrib').filter(f => f.endsWith('.json')).sort()) {
  contributes = merge(contributes, JSON.parse(readFileSync(`contrib/${f}`, 'utf8')));
}
const nls = localize(contributes);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.contributes = contributes;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
writeFileSync('package.nls.json', JSON.stringify(nls, null, 2) + '\n');
console.log(`merged ${Object.keys(contributes).length} contribution points, ${Object.keys(nls).length} strings`);

for (const f of readdirSync('.').filter(f => /^package\.nls\..+\.json$/.test(f))) {
  const tr = JSON.parse(readFileSync(f, 'utf8'));
  const missing = Object.keys(nls).filter(k => !(k in tr));
  const stale = Object.keys(tr).filter(k => !(k in nls));
  if (missing.length || stale.length) console.log(`${f}: ${missing.length} missing, ${stale.length} stale${stale.length ? ` (${stale.join(', ')})` : ''}`);
}
