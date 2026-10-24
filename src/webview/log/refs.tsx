import { compareRefNames } from '../../shared/branchesTree';
import { iconUrl } from '../lib/icons';

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface RefLabel {
  text: string;
  kinds: RefKind[];
  tip: string;
  /** Short ref names represented by the label (for menus). */
  names: string[];
}

export interface RefLabelOptions {
  compact: boolean;
  showTagNames: boolean;
  currentBranch?: string;
}

/** Groups decorations of one commit into labels, like IntelliJ's LabelPainter. */
export function refLabels(refs: string[], o: RefLabelOptions): RefLabel[] {
  const locals: string[] = [];
  const remotes: string[] = [];
  const tags: string[] = [];
  let head = false;
  for (const r of refs) {
    if (r === 'HEAD') head = true;
    else if (r.startsWith('refs/heads/')) locals.push(r.slice(11));
    else if (r.startsWith('refs/remotes/')) {
      if (!r.endsWith('/HEAD')) remotes.push(r.slice(13));
    } else if (r.startsWith('refs/tags/')) tags.push(r.slice(10));
  }
  const out: RefLabel[] = [];
  if (head && !(o.currentBranch && locals.includes(o.currentBranch))) out.push({ text: 'HEAD', kinds: ['head'], tip: 'HEAD', names: ['HEAD'] });
  const usedRemotes = new Set<string>();
  const sortedLocals = [...locals].sort((a, b) => (a === o.currentBranch ? -1 : b === o.currentBranch ? 1 : compareRefNames(a, b)));
  for (const l of sortedLocals) {
    const kind: RefKind = l === o.currentBranch ? 'head' : 'local';
    const tracking = o.compact ? remotes.filter(r => r.slice(r.indexOf('/') + 1) === l) : [];
    tracking.forEach(r => usedRemotes.add(r));
    if (tracking.length) {
      const remoteNames = tracking.map(r => r.slice(0, r.indexOf('/')));
      out.push({ text: `${remoteNames.join(' & ')} & ${l}`, kinds: [kind, 'remote'], tip: [l, ...tracking].join(', '), names: [l, ...tracking] });
    } else out.push({ text: l, kinds: [kind], tip: l, names: [l] });
  }
  for (const r of remotes) if (!usedRemotes.has(r)) out.push({ text: r, kinds: ['remote'], tip: r, names: [r] });
  if (tags.length) {
    if (o.showTagNames) for (const t of tags) out.push({ text: t, kinds: ['tag'], tip: t, names: [t] });
    else out.push({ text: o.compact && out.length ? '' : tags.length > 1 ? `${tags[0]} +${tags.length - 1}` : tags[0], kinds: ['tag'], tip: tags.join(', '), names: tags });
  }
  return out;
}

export const REF_MASK = () => `url("${iconUrl('dvcs/branchLabel', false)}")`;

export function RefIcon({ kinds }: { kinds: RefKind[] }) {
  if (kinds.length > 1) {
    const color = (k: RefKind) => `var(--ref-${k})`;
    return <span class="ref-icon multi" style={{ '--c1': color(kinds[0]), '--c2': color(kinds[1]) } as any} />;
  }
  return <span class={`ref-icon ${kinds[0]}`} />;
}

export function RefLabels({ labels, left }: { labels: RefLabel[]; left?: boolean }) {
  if (!labels.length) return null;
  return (
    <span class={`refs ${left ? 'left' : ''}`}>
      {labels.map(l => (
        <span class="ref-label" data-tip={l.tip} key={l.tip}>
          <RefIcon kinds={l.kinds} />
          {l.text && <span>{l.text}</span>}
        </span>
      ))}
    </span>
  );
}
