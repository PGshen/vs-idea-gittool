// Types shared by the extension host and the webviews. Keep this file free of imports.

/**
 * Status letter of a change, like the file colors in IntelliJ:
 * M modified (blue), A added (green), D deleted (gray), R renamed / moved (blue),
 * C copied, T type changed, U merge conflict (red), ? unversioned (brown/red), ! ignored (olive).
 */
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';

export interface Change {
  /** Absolute path of the repository root. */
  root: string;
  /** Repository-relative path (forward slashes). For deleted files, the old path. */
  path: string;
  /** Previous path for renames and copies. */
  oldPath?: string;
  status: ChangeStatus;
  /** Index (staged) status letter, from `git status`. Only for local changes. */
  index?: string;
  /** Work tree status letter, from `git status`. Only for local changes. */
  workTree?: string;
  /** Lines added / removed (numstat), when known. */
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export type RefType = 'HEAD' | 'local' | 'remote' | 'tag' | 'stash';

export interface Ref {
  /** Full ref name, for example refs/heads/master. */
  fullName: string;
  /** Short name, for example master, origin/master, v1.0. */
  name: string;
  type: RefType;
  hash: string;
  /** Upstream short name for local branches, for example origin/master. */
  upstream?: string;
  upstreamGone?: boolean;
  ahead?: number;
  behind?: number;
  /** For remote branches: the remote name. */
  remote?: string;
  current?: boolean;
  /** Commit time of the ref target, used for sorting "Recent" branches. */
  date?: number;
  favorite?: boolean;
  /** Repository root, set where refs of several repositories are mixed (multi-root log). */
  root?: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  /** stash@{N} */
  ref: string;
  hash: string;
  message: string;
  branch?: string;
  date: number;
}

export type OngoingOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'am';

export interface RepoInfo {
  root: string;
  /** Folder name of the root, shown in the UI. */
  name: string;
  /** Current branch short name, or undefined when HEAD is detached. */
  branch?: string;
  headHash?: string;
  detached: boolean;
  operation: OngoingOperation;
  /** For a rebase: branch being rebased and onto. */
  rebaseHeadName?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Fresh repository with no commits. */
  empty: boolean;
  shallow: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorDate: number;
  committerName: string;
  committerEmail: string;
  commitDate: number;
  /** Decorations: full ref names pointing at this commit. */
  refs: string[];
  /** Root of the repository the commit belongs to. */
  root: string;
}

export interface CommitDetails extends Commit {
  body: string;
  /** GPG signature status letter from %G? */
  signature?: string;
  signer?: string;
}

export interface ShelvedChangeList {
  id: string;
  root: string;
  name: string;
  date: number;
  files: Change[];
  /** Deleted shelves stay in "Recently Deleted" until cleaned. */
  deleted?: boolean;
}

export interface ChangeListInfo {
  id: string;
  name: string;
  comment?: string;
  isDefault: boolean;
  /** Files are keyed as `${root}\u0000${path}`. */
  files: string[];
}

/** One row of the commit graph, computed on the host. */
export interface GraphRow {
  /** Lane of the commit circle. */
  lane: number;
  color: number;
  /** Edges drawn in the row. y: 0 top, 1 middle, 2 bottom. */
  edges: GraphEdge[];
  /** Total lane count in this row, used for column width. */
  width: number;
  /** Segment id per lane at the row top / bottom boundary (-1 = free). Used by the long edge pass. */
  top?: number[];
  bottom?: number[];
}

export interface GraphEdge {
  fromLane: number;
  fromY: 0 | 1;
  toLane: number;
  toY: 1 | 2;
  color: number;
  /** Dashed edge, for an edge that goes to a commit not loaded / filtered out. */
  dashed?: boolean;
  /** Edge segment (child commit -> parent commit) this part belongs to. */
  seg?: number;
  /** Long edge stub: arrow at the middle of the row pointing down (to the parent) or up (to the child). */
  arrow?: 'down' | 'up';
  /** Hash of the commit at the other end of a long edge stub (click to jump). */
  jump?: string;
}
