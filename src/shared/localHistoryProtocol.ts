// Protocol between the Local History host (src/features/localHistory) and its webview. No imports.

export type LhMode = 'file' | 'dir' | 'project' | 'selection';

/** One row of the activity list: a recorded change (or a group of changes) or a label. */
export interface LhItem {
  /** Smallest event id of the item: the state "before" the item is the state before this event. */
  id: number;
  /** Largest event id of the item. */
  lastId: number;
  /** Unix milliseconds. */
  ts: number;
  kind: 'label' | 'system' | 'change' | 'external';
  title: string;
  /** Number of files changed by the item. */
  files: number;
  /** File paths, for the search by file name. */
  paths: string[];
}

export interface LhInit {
  mode: LhMode;
  /** Name shown in the title: file name, directory or project name. */
  displayName: string;
  /** For selection history: 1-based line range shown in the title. */
  lines?: [number, number];
  showSystem: boolean;
  /** Item to select first (Recent Changes). */
  select?: number;
}

export interface LhSide {
  title: string;
  /** Text content; missing when the file did not exist. */
  text?: string;
  missing?: boolean;
  unavailable?: boolean;
  /** First line number (for selection history). */
  firstLine?: number;
}

export type LhDiff =
  | { kind: 'text'; left: LhSide; right: LhSide }
  | { kind: 'files'; files: LhFile[] }
  | { kind: 'empty'; text: string };

export interface LhFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the workspace folder, shown in the tree. */
  rel: string;
  status: 'M' | 'A' | 'D';
}

/** Diff with the local version ("local directory") or with the next revision. */
export type LhDiffMode = 'local' | 'next';
