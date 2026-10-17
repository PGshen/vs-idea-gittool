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
}

export interface LogOptionsDto {
  sort: 'topo' | 'date';
  firstParent: boolean;
  noMerges?: boolean;
}

/** View options shared by all log tabs (IntelliJ VcsLogUiProperties). */
export interface LogUiSettings {
  showBranches: boolean;
  columns: { author: boolean; date: boolean; hash: boolean };
  columnWidths: { author: number; date: number; hash: number };
  compactRefs: boolean;
  showTagNames: boolean;
  preferCommitDate: boolean;
  refsOnLeft: boolean;
  showDetails: boolean;
  showRootNames: boolean;
  highlightMyCommits: boolean;
  highlightMergeCommits: boolean;
  highlightCurrentBranch: boolean;
  changesGroupByDirectory: boolean;
  showOnlyAffectedChanges: boolean;
  branchesGroupByDirectory: boolean;
  branchesShowTags: boolean;
  branchesSingleClickFilter: boolean;
  branchesSingleClickNavigate: boolean;
  /** Width of the right panel and the branches panel, px. */
  rightWidth: number;
  branchesWidth: number;
}

export const DEFAULT_LOG_SETTINGS: LogUiSettings = {
  showBranches: true,
  columns: { author: true, date: true, hash: false },
  columnWidths: { author: 120, date: 140, hash: 80 },
  compactRefs: true,
  showTagNames: false,
  preferCommitDate: false,
  refsOnLeft: false,
  showDetails: true,
  showRootNames: false,
  highlightMyCommits: false,
  highlightMergeCommits: false,
  highlightCurrentBranch: true,
  changesGroupByDirectory: true,
  showOnlyAffectedChanges: false,
  branchesGroupByDirectory: true,
  branchesShowTags: false,
  branchesSingleClickFilter: false,
  branchesSingleClickNavigate: true,
  rightWidth: 360,
  branchesWidth: 220,
};

export type LogMode = 'log' | 'history' | 'compare';

export interface LogInit {
  tabId: string;
  mode: LogMode;
  title: string;
  repos: { root: string; name: string }[];
  root: string;
  refs: Ref[];
  head: { branch?: string; hash?: string; detached: boolean; operation: string };
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
}

export interface RowsResult {
  start: number;
  rows: RowData[];
  total: number;
  done: boolean;
  error?: string;
}

export interface DetailsResult {
  details: CommitDetails[];
  changes: Change[];
  left: string;
  right: string;
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
}
