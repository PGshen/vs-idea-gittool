// Merges contrib/*.json fragments into package.json "contributes".
// Arrays are concatenated, objects are merged recursively.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

let contributes = {};
for (const f of readdirSync('contrib').filter(f => f.endsWith('.json')).sort()) {
  contributes = merge(contributes, JSON.parse(readFileSync(`contrib/${f}`, 'utf8')));
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.contributes = contributes;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`merged ${Object.keys(contributes).length} contribution points`);
