import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves symlinks in a directory path (e.g. /home/x -> /data/home/x), the way Git reports
 * repository roots. Missing trailing parts (a deleted folder) are kept as they are.
 */
export function resolveDirectoryPath(dir: string): string {
  const abs = path.resolve(dir);
  for (let existing = abs; ; existing = path.dirname(existing)) {
    try {
      return path.join(fs.realpathSync(existing), path.relative(existing, abs));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || path.dirname(existing) === existing) return abs;
    }
  }
}

/** `rel` (from path.relative) does not leave its base. */
export function isInside(rel: string): boolean {
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Spellings of a file to match against repository roots, cheapest first: as given, then with
 * symlinked parent directories resolved (keeping a symlinked file itself, which Git tracks by
 * its own path), then fully resolved (a folder that is itself an alias). Computed lazily, since
 * almost every lookup matches on the first one.
 */
export function* fileCandidates(file: string): Generator<string> {
  const abs = path.resolve(file);
  yield abs;
  const parentResolved = path.join(resolveDirectoryPath(path.dirname(abs)), path.basename(abs));
  if (parentResolved !== abs) yield parentResolved;
  const resolved = resolveDirectoryPath(abs);
  if (resolved !== abs && resolved !== parentResolved) yield resolved;
}

/** Path of `file` relative to the repository `root`, seeing through directory aliases. */
export function relativeToRoot(root: string, file: string): string | undefined {
  for (const candidate of fileCandidates(file)) {
    const rel = path.relative(root, candidate);
    if (isInside(rel)) return rel;
  }
  return undefined;
}
