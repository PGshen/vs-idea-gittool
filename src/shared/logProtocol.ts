// Messages between the log host (src/features/log) and the log webview (src/webview/log).
import type { Change, CommitDetails, GraphRow, Ref } from './types';

export interface LogFiltersDto {
  branches: string[];
  users: string[];
  since?: number;
  until?: number;
  paths: string[];
  text: string;
  regex: boolean;
  matchCase: boolean;
  follow?: boolean;
  lines?: { path: string; start: number; end: number };
  /** Multi-root log: shown roots (empty = all). */
  roots?: string[];
}

export interface LogOptionsDto {
  sort: 'topo' | 'date';
  firstParent: boolean;
  noMerges?: boolean;
  collapseLinear?: boolean;
}

/** View options shared by all log tabs (IntelliJ VcsLogUiProperties). */
export interface LogUiSettings {
  showBranches: boolean;
  columns: { author: boolean; date: boolean; hash: boolean; signature: boolean };
  columnWidths: { author: number; date: number; hash: number; signature: number };
  compactRefs: boolean;
  showTagNames: boolean;
  /** View Options > Long Edges. */
  showLongEdges: boolean;
  preferCommitDate: boolean;
  refsOnLeft: boolean;
  showDetails: boolean;
  showRootNames: boolean;
  highlightMyCommits: boolean;
  highlightMergeCommits: boolean;
  highlightCurrentBranch: boolean;
  changesGroupByDirectory: boolean;
  changesGroupByRepository: boolean;
  showOnlyAffectedChanges: boolean;
  /** Configure Layout > Show Diff Preview / Diff Preview Location. */
  showDiffPreview: boolean;
  diffPreviewLocation: 'bottom' | 'right';
  /** Diff preview viewer: unified instead of side-by-side, and collapsed unchanged fragments. */
  diffUnified: boolean;
  diffCollapseUnchanged: boolean;
  diffPreviewSize: number;
  branchesGroupByDirectory: boolean;
  branchesGroupByRepository: boolean;
  branchesShowTags: boolean;
  branchesSingleClickFilter: boolean;
  branchesSingleClickNavigate: boolean;
  /** Branches pane: Show My Branches. */
  showMyBranches: boolean;
  /** Width of the right panel and the branches panel, px. */
  rightWidth: number;
  branchesWidth: number;
}

export const DEFAULT_LOG_SETTINGS: LogUiSettings = {
  showBranches: true,
  columns: { author: true, date: true, hash: false, signature: false },
  columnWidths: { author: 120, date: 140, hash: 80, signature: 28 },
  compactRefs: true,
  showTagNames: false,
  showLongEdges: false,
  preferCommitDate: false,
  refsOnLeft: false,
  showDetails: true,
  showRootNames: false,
  highlightMyCommits: false,
  highlightMergeCommits: false,
  highlightCurrentBranch: true,
  changesGroupByDirectory: true,
  changesGroupByRepository: true,
  showOnlyAffectedChanges: false,
  showDiffPreview: false,
  diffPreviewLocation: 'bottom',
  diffUnified: false,
  diffCollapseUnchanged: true,
  diffPreviewSize: 300,
  branchesGroupByDirectory: true,
  branchesGroupByRepository: true,
  branchesShowTags: false,
  branchesSingleClickFilter: false,
  branchesSingleClickNavigate: true,
  showMyBranches: false,
  rightWidth: 360,
  branchesWidth: 220,
};

export type LogMode = 'log' | 'history' | 'compare';

export interface RepoHead {
  branch?: string;
  hash?: string;
  detached: boolean;
  operation: string;
}

/** One repository of a multi-root log. */
export interface LogRepo {
  root: string;
  name: string;
  head: RepoHead;
  /** Index into the IntelliJ root color palette. */
  color: number;
}

export interface LogInit {
  tabId: string;
  mode: LogMode;
  title: string;
  repos: LogRepo[];
  /** The log shows commits of all repositories in `repos` (IntelliJ multi-root log). */
  multi: boolean;
  root: string;
  /** References; with `multi`, of all repositories, each with `root` set. */
  refs: Ref[];
  head: RepoHead;
  filters: LogFiltersDto;
  options: LogOptionsDto;
  settings: LogUiSettings;
  /** user.name / user.email, for "me" and "My Commits". */
  me: { name: string; email: string };
  /** For compare tabs: banner text. */
  compare?: { ref: string; with: string };
  /** Hash to select after loading. */
  select?: string;
}

/** One table row, short keys to keep messages small. */
export interface RowData {
  h: string;
  p: string[];
  s: string;
  an: string;
  ae: string;
  at: number;
  cn: string;
  ct: number;
  refs: string[];
  g: GraphRow;
  /** In the current branch (reachable from HEAD). */
  b: boolean;
  /** Index of the repository in LogInit.repos (multi-root log). */
  r?: number;
}

export interface RowsResult {
  start: number;
  rows: RowData[];
  total: number;
  done: boolean;
  error?: string;
  /** Model generation: rows of an older generation must not be mixed with newer ones. */
  gen: number;
}

export interface RefreshEvent {
  refs: Ref[];
  head: RepoHead;
  repos: LogRepo[];
  total: number;
  done: boolean;
  gen: number;
}

export interface DetailsResult {
  details: CommitDetails[];
  changes: Change[];
  left: string;
  right: string;
  /** Per-repository revisions when the selected commits belong to several repositories. */
  revs?: Record<string, { left: string; right: string }>;
  /** For merge commits shown with "Show Changes to Parents". */
  toParents?: { parent: string; changes: Change[] }[];
}

export interface ContextInfo {
  /** All selected commits are reachable from HEAD. */
  inHead: boolean;
  /** Some selected commit is already in the upstream of the current branch. */
  pushed: boolean;
  hasMerges: boolean;
  /** HEAD is the selected commit. */
  isHead: boolean;
  /** Refs that point at the single selected commit. */
  refs: Ref[];
  /** URL of the commit on GitHub / GitLab / Bitbucket, when the remote is a known host. */
  webUrl?: string;
  operation: string;
  /** Selected commits belong to more than one repository. */
  mixedRoots?: boolean;
  /** The repository has remote branches (for Add Commits to Remote Branch). */
  hasRemoteBranches?: boolean;
}

/** GPG signature status of a commit (%G?): G good, B bad, U unknown validity, X/Y expired, R revoked, E cannot check, N none. */
export interface SignatureInfo {
  status: string;
  signer?: string;
  key?: string;
}

export interface DiffLine {
  /** ' ' context, '-' removed, '+' added. */
  t: ' ' | '-' | '+';
  s: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiffResult {
  path: string;
  oldPath?: string;
  binary: boolean;
  /** Too large to show in the preview. */
  tooLarge?: boolean;
  hunks: DiffHunk[];
  /** Line counts of both versions, to show the size of collapsed fragments. */
  oldTotal: number;
  newTotal: number;
}
