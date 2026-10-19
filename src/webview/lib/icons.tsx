import { useEffect, useState } from 'preact/hooks';
import { MONO_ICONS } from './monoIcons';
import { boot, on, theme } from './rpc';

/**
 * IntelliJ New UI icon. `name` is a path under media/icons without extension, e.g. "vcs/push", "general/refresh".
 * The `_dark` variant is picked automatically on dark themes.
 */
export function Icon({ name, size = 16, class: cls, title }: { name: string; size?: 12 | 14 | 16 | 20; class?: string; title?: string }) {
  const dark = useDark();
  const src = iconUrl(name, dark);
  // Monochrome icons carry their shape as a mask: the "vscode" appearance paints them in --vscode-icon-foreground.
  const mono = MONO_ICONS.has(name);
  return (
    <img
      class={`icon s${size} ${mono ? 'mono ' : ''}${cls ?? ''}`}
      style={mono ? { '--icon-mask': `url("${iconUrl(name, false)}")` } : undefined}
      src={src}
      title={title}
      draggable={false}
      onError={e => {
        // Not every icon has a dark variant.
        const img = e.currentTarget as HTMLImageElement;
        const light = iconUrl(name, false);
        if (img.src !== light) img.src = light;
      }}
    />
  );
}

export function iconUrl(name: string, dark = theme.dark) {
  return `${boot.iconsBase}/${name}${dark && !NO_DARK.has(name) ? '_dark' : ''}.svg`;
}

const NO_DARK = new Set([
  'fileTypes/go', 'fileTypes/rust', 'fileTypes/ruby', 'fileTypes/dart', 'fileTypes/lua', 'fileTypes/svelte', 'fileTypes/rLang', 'fileTypes/elixir',
  'fileTypes/vue', 'fileTypes/gitignore', 'fileTypes/http', 'fileTypes/jenkins', 'fileTypes/wsdl', 'fileTypes/eclipse', 'git/verified', 'git/signed']);

export function useDark() {
  const [dark, setDark] = useState(theme.dark);
  useEffect(() => on('themeChanged', d => setDark(d.dark)), []);
  return dark;
}

const EXT_ICONS: Record<string, string> = {
  java: 'java', class: 'javaClass', kt: 'kotlin', kts: 'kotlinScript', gradle: 'gradle', groovy: 'groovy',
  py: 'python', pyi: 'python', pyw: 'python', go: 'go', rs: 'rust', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php',
  scala: 'scala', sc: 'scala', sbt: 'scala', dart: 'dart', lua: 'lua', svelte: 'svelte', r: 'rLang', ex: 'elixir', exs: 'elixir',
  js: 'javaScript', mjs: 'javaScript', cjs: 'javaScript', jsx: 'javaScript',
  ts: 'typeScript', tsx: 'typeScript', mts: 'typeScript', cts: 'typeScript',
  json: 'json', jsonc: 'json', json5: 'json', html: 'html', htm: 'html', xhtml: 'xhtml',
  css: 'css', scss: 'css', sass: 'css', less: 'css', xml: 'xml', xsd: 'xsd', wsdl: 'wsdl', svg: 'image',
  md: 'markdown', markdown: 'markdown', rst: 'rst', txt: 'text', log: 'text',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', properties: 'properties', ini: 'config', cfg: 'config', conf: 'config', env: 'config',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', bat: 'microsoftWindows', cmd: 'microsoftWindows', ps1: 'microsoftWindows',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', ico: 'image', icns: 'image',
  zip: 'archive', jar: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive', war: 'archive',
  sql: 'sql', c: 'c', h: 'h', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'h', hh: 'h', cs: 'Csharp', swift: 'swiftLang',
  pl: 'perl', pm: 'perl', graphql: 'graphql', gql: 'graphql', tf: 'terraform', vue: 'vue', ipynb: 'jupyter',
  patch: 'patch', diff: 'patch', csv: 'csv', tsv: 'csv', ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  http: 'http', jsp: 'jsp', jspx: 'jspx', iml: 'ideaModule', map: 'sourceMap', bazel: 'bazel', bzl: 'bazel',
  editorconfig: 'editorConfig', idl: 'idl', mf: 'manifest',
};

const NAME_ICONS: Record<string, string> = {
  '.gitignore': 'gitignore', '.gitattributes': 'gitignore', '.ignore': 'gitignore', dockerfile: 'docker',
  '.editorconfig': 'editorConfig', 'build.bazel': 'bazel', build: 'bazel', 'module.bazel': 'bazel', workspace: 'bazel',
  jenkinsfile: 'jenkins', 'manifest.mf': 'manifest', 'go.mod': 'go', 'go.sum': 'go', 'go.work': 'go', 'cargo.toml': 'rust',
  'cargo.lock': 'rust', gemfile: 'ruby', rakefile: 'ruby', 'build.gradle.kts': 'gradle', 'settings.gradle.kts': 'gradle',
  'requirements.txt': 'python', 'pyproject.toml': 'python',
};

/** Icon name for a file, like IntelliJ's file type icons. */
export function fileIconName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAME_ICONS[base]) return `fileTypes/${NAME_ICONS[base]}`;
  if (base.startsWith('dockerfile')) return 'fileTypes/docker';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1) : '';
  if (path.includes('.github/workflows/') && (ext === 'yml' || ext === 'yaml')) return 'fileTypes/yaml';
  return `fileTypes/${EXT_ICONS[ext] ?? (dot >= 0 ? 'unknown' : 'text')}`;
}

export function FileIcon({ path }: { path: string }) {
  return <Icon name={fileIconName(path)} />;
}
