import { buildDirectoryTree, CheckState, TreeNode, walkTree } from '../lib/components';
import { FileIcon } from '../lib/icons';
import { changeKey } from '../../shared/commitProtocol';
import { Change } from '../../shared/types';

export interface FileNodeData {
  kind: 'file';
  change: Change;
}

export interface GroupNodeData {
  kind: 'changelist' | 'unversioned' | 'ignored' | 'conflicts' | 'repo' | 'dir' | 'shelf' | 'stash' | 'recycled';
  id?: string;
  root?: string;
  dir?: string;
}

export type NodeData = FileNodeData | GroupNodeData;

export function countText(n: number) {
  return n === 0 ? 'No files' : n === 1 ? '1 file' : `${n} files`;
}

function dirOf(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export interface FileNodeOptions {
  /** Key of the node; defaults to changeKey. */
  key?: (c: Change) => string;
  checkable?: boolean;
  /** Repository name, shown as the hint of files in the repository root (flat mode). */
  repoName?: (root: string) => string;
  flat: boolean;
}

export function fileNode(c: Change, o: FileNodeOptions): TreeNode<NodeData> {
  const name = c.path.slice(c.path.lastIndexOf('/') + 1);
  let hint: string | undefined;
  if (o.flat) hint = dirOf(c.path) || o.repoName?.(c.root);
  if (c.oldPath && c.oldPath !== c.path) {
    const from = dirOf(c.oldPath) === dirOf(c.path) ? c.oldPath.slice(c.oldPath.lastIndexOf('/') + 1) : c.oldPath;
    hint = `${hint ? hint + ' ' : ''}— moved from ${from}`;
  }
  return {
    key: o.key ? o.key(c) : changeKey(c),
    label: name,
    text: name,
    prefix: <FileIcon path={c.path} />,
    labelClass: `st-${c.status}`,
    hint,
    checkable: o.checkable,
    data: { kind: 'file', change: c },
    tip: `${c.path}`,
  };
}

/**
 * Files of one group, optionally grouped by repository and by directory.
 */
export function groupFiles(
  files: Change[],
  keyPrefix: string,
  opts: { groupByDirectory: boolean; groupByRepository: boolean; repos: { root: string; name: string; branch?: string }[]; checkable: boolean; fileKey?: (c: Change) => string },
): TreeNode<NodeData>[] {
  const repoName = (root: string) => opts.repos.find(r => r.root === root)?.name ?? root.slice(root.lastIndexOf('/') + 1);
  const make = (list: Change[], prefix: string): TreeNode<NodeData>[] =>
    buildDirectoryTree(list, c => fileNode(c, { key: opts.fileKey, checkable: opts.checkable, repoName, flat: !opts.groupByDirectory }), prefix, {
      flat: !opts.groupByDirectory,
    }).map(n => markCheckable(n, opts.checkable));
  const roots = [...new Set(files.map(f => f.root))];
  if (opts.groupByRepository && opts.repos.length > 1 && roots.length > 0) {
    return roots
      .sort()
      .map(root => {
        const list = files.filter(f => f.root === root);
        const repo = opts.repos.find(r => r.root === root);
        return {
          key: `${keyPrefix}repo:${root}`,
          label: repoName(root),
          text: repoName(root),
          icon: 'nodes/folder',
          hint: repo?.branch ? `${repo.branch}  ${countText(list.length)}` : countText(list.length),
          children: make(list, `${keyPrefix}repo:${root}/`),
          checkable: opts.checkable,
          data: { kind: 'repo', root } as GroupNodeData,
        } satisfies TreeNode<NodeData>;
      });
  }
  return make(files, keyPrefix);
}

function markCheckable(n: TreeNode<NodeData>, checkable: boolean): TreeNode<NodeData> {
  n.checkable = checkable;
  if (n.children) n.children.forEach(c => markCheckable(c, checkable));
  return n;
}

/** File changes below a node (or the node itself). */
export function filesOf(n: TreeNode<NodeData>): Change[] {
  if (n.data?.kind === 'file') return [n.data.change];
  const out: Change[] = [];
  if (n.children) {
    walkTree(n.children, c => {
      if (c.data?.kind === 'file') out.push(c.data.change);
    });
  }
  return out;
}

/** Unique changes of several nodes. */
export function filesOfNodes(nodes: TreeNode<NodeData>[]): Change[] {
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const n of nodes) {
    for (const c of filesOf(n)) {
      const k = changeKey(c);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    }
  }
  return out;
}

/** Tri-state check for a node from the set of included file keys. */
export function makeCheckState(included: Set<string>, keyOf: (c: Change) => string = changeKey) {
  const cache = new Map<string, CheckState>();
  return (n: TreeNode<NodeData>): CheckState => {
    if (n.data?.kind === 'file') return included.has(keyOf(n.data.change)) ? 'on' : 'off';
    const hit = cache.get(n.key);
    if (hit) return hit;
    const files = filesOf(n);
    let on = 0;
    for (const f of files) if (included.has(keyOf(f))) on++;
    const st: CheckState = files.length === 0 || on === 0 ? 'off' : on === files.length ? 'on' : 'mixed';
    cache.set(n.key, st);
    return st;
  };
}

/** Keys of all expandable nodes, used for "Expand All". */
export function allGroupKeys(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  walkTree(nodes, n => {
    if (n.children) out.push(n.key);
  });
  return out;
}
