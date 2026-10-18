// Messages between the Branches tab of the Commit tool window (webview "commit") and the host (src/features/ops).
// The tab re-creates IntelliJ's Git branches popup (GitBranchesTreePopup). Keep this file free of imports.

export type BranchRefKind = 'local' | 'remote' | 'tag';
export type BranchOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'am';

/** One entry of an action list (top actions or a ref submenu). */
export interface ActionItem {
  label: string;
  /** Icon path under media/icons, e.g. "vcs/push". */
  icon?: string;
  /** Shortcut text shown on the right, platform specific ("⌘T" / "Ctrl+T"). */
  shortcut?: string;
  /** Identifier the host runs: a command id, or a ref action id for submenus. */
  action?: string;
  separator?: true;
}

export interface BranchRef {
  /** Short name: master, origin/master, v1.0. */
  name: string;
  fullName: string;
  type: BranchRefKind;
  current?: boolean;
  favorite?: boolean;
  ahead?: number;
  behind?: number;
  upstream?: string;
  /** For remote branches: the remote name. */
  remote?: string;
}

export interface BranchesRepo {
  root: string;
  name: string;
  /** Current branch, undefined when HEAD is detached. */
  branch?: string;
  operation: BranchOperation;
  /** Recently checked out local branches, newest first (without the current one). */
  recent: string[];
  refs: BranchRef[];
}

export interface BranchesSettings {
  groupByDirectory: boolean;
  groupByRepository: boolean;
  showRecent: boolean;
  showTags: boolean;
  /** "Add in Search Results: Actions". */
  searchActions: boolean;
  /** Execute branch operations on all roots (synchronous branch control). */
  syncControl: boolean;
}

export interface BranchesState {
  /** macOS shortcut symbols (⌘⇧⌥) instead of Ctrl+Shift+Alt. */
  mac: boolean;
  repos: BranchesRepo[];
  /** Synchronous branch control is active (several repositories and the setting is on). */
  sync: boolean;
  /** With synchronous control: refs present in every repository (current when current everywhere). */
  common: BranchRef[];
  /** Top actions: Update Project…, Commit…, Push…, ongoing operation actions, New Branch…, Checkout Tag or Revision…. */
  top: ActionItem[];
  settings: BranchesSettings;
  fetching: boolean;
}

/** Address of a ref in a request from the tab. `root` is omitted for refs of the synchronous (common) section. */
export interface RefAddress {
  root?: string;
  name: string;
  type: BranchRefKind;
}
