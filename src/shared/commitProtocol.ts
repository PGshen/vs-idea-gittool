// Messages between the Commit tool window (webview "commit") and the host (src/features/commit).
import { Change, ChangeListInfo, OngoingOperation, ShelvedChangeList, Stash } from './types';

export interface CommitRepoInfo {
  root: string;
  name: string;
  branch?: string;
  headHash?: string;
  operation: OngoingOperation;
  rebaseHeadName?: string;
  /** Short hash (or branch) being rebased onto / merged / cherry-picked. */
  operationTarget?: string;
}

export interface CommitOptionsState {
  author: string;
  signOff: boolean;
  /** "Create extra commit with file movements". */
  extraMoveCommit: boolean;
}

export interface ViewSettings {
  groupByDirectory: boolean;
  groupByRepository: boolean;
  showIgnored: boolean;
  /** What a double click on a file does. */
  doubleClick: 'diff' | 'source';
  showRecycledShelves: boolean;
}

export interface ShelfFileInfo extends Change {
  oldBlob?: string;
  newBlob?: string;
}

export interface ShelfInfo extends Omit<ShelvedChangeList, 'files'> {
  files: ShelfFileInfo[];
}

export interface StashInfo extends Stash {
  root: string;
  repoName: string;
}

export interface CommitViewState {
  repos: CommitRepoInfo[];
  changelists: (ChangeListInfo & { changes: Change[] })[];
  unversioned: Change[];
  ignored: Change[];
  conflicts: Change[];
  /** Included (checked) file keys `${root}\0${path}`. */
  included: string[];
  settings: ViewSettings;
  options: CommitOptionsState;
  shelves: ShelfInfo[];
  stashes: StashInfo[];
  messageHistory: string[];
  loading: boolean;
}

export function changeKey(c: { root: string; path: string }) {
  return `${c.root}\u0000${c.path}`;
}
