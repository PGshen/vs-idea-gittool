// Host <-> merge webview protocol. Keep this file free of non-shared imports.
import type { IgnorePolicy } from './mergeModel';

/** A title made of plain and bold parts, like IntelliJ's "Changes from <b>master</b>". */
export type TitleParts = { text: string; bold?: boolean }[];

export interface MergeSettings {
  highlight: 'words' | 'lines' | 'none';
  ignore: IgnorePolicy;
  syncScroll: boolean;
  /** "Automatically apply non-conflicting changes" */
  autoApply: boolean;
}

export const DEFAULT_MERGE_SETTINGS: MergeSettings = { highlight: 'words', ignore: 'none', syncScroll: true, autoApply: false };

export interface MergeInit {
  path: string;
  fileName: string;
  /** Left = Yours, right = Theirs (already swapped during a rebase). */
  titles: { left: TitleParts; result: TitleParts; right: TitleParts };
  base: string;
  left: string;
  right: string;
  settings: MergeSettings;
}

/** Compare Contents targets. */
export type CompareMode = 'left-result' | 'result-right' | 'left-right' | 'base-left' | 'base-result' | 'base-right';
