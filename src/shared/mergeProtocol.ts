// Host <-> merge webview protocol. Keep this file free of non-shared imports.
import type { ChangeState, IgnorePolicy } from './mergeModel';

/** A title made of plain and bold parts, like IntelliJ's "Changes from <b>master</b>". */
export type TitleParts = { text: string; bold?: boolean }[];

export interface MergeSettings {
  highlight: 'words' | 'lines' | 'none';
  ignore: IgnorePolicy;
  syncScroll: boolean;
  /** "Automatically apply non-conflicting changes" */
  autoApply: boolean;
  /** "Collapse Unchanged Fragments" (TextDiffSettings.isExpandByDefault inverted). */
  collapseUnchanged: boolean;
}

export const DEFAULT_MERGE_SETTINGS: MergeSettings = { highlight: 'words', ignore: 'none', syncScroll: true, autoApply: false, collapseUnchanged: false };

/** Saved progress of a file in the iterative Conflicts dialog (MergeConflictModel kept by MergeConflictIterativeDataHolder). */
export interface MergeProgress {
  /** Result lines. */
  lines: string[];
  states: ChangeState[];
  contentModified: boolean;
}

export interface MergeInit {
  path: string;
  fileName: string;
  /** Left = Yours, right = Theirs (already swapped during a rebase). */
  titles: { left: TitleParts; result: TitleParts; right: TitleParts };
  base: string;
  left: string;
  right: string;
  settings: MergeSettings;
  /** "Diff & Merge > Context lines" (1, 2, 4, 8, or -1 to disable collapsing). */
  contextLines: number;
  /** Opened from the iterative Conflicts dialog: "Save and Close" instead of "Cancel". */
  iterative: boolean;
  /** Progress to continue from (iterative mode). */
  progress?: MergeProgress;
}

/** MergeResult */
export type MergeResult = 'CANCEL' | 'LEFT' | 'RIGHT' | 'RESOLVED';

/** Sent by the webview when it finishes: the result text and the model state. */
export interface MergeFinish {
  result: MergeResult;
  /** Result lines (LF separated; the host restores the line separators of the file). */
  lines: string[];
  states: ChangeState[];
  contentModified: boolean;
}

/** Compare Contents targets. */
export type CompareMode = 'left-result' | 'result-right' | 'left-right' | 'base-left' | 'base-result' | 'base-right';
