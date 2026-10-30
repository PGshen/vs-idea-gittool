// Action model of the Git branches popup / Branches tab. Pure functions (using the selected translations), so that the
// labels and the order can be tested (test/branchActions.test.ts).
import * as vscode from 'vscode';
import { translate } from '../../shared/l10n';
import { ActionItem, BranchOperation, BranchRef } from '../../shared/branchesProtocol';

/** Ref submenu actions that are not plain `{root, name, type}` commands. */
export const OPEN_WORKTREE = 'worktree.open';
export const NEW_WORKTREE = 'worktree.create';

/** Keyboard shortcut text as IntelliJ shows it: "⇧⌘K" on macOS, "Ctrl+Shift+K" elsewhere. */
export function shortcut(keys: string, mac: boolean): string {
  const parts = keys.split('+');
  if (!mac) return parts.join('+');
  const order = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
  const symbols: Record<string, string> = { Ctrl: '⌘', Cmd: '⌘', Alt: '⌥', Shift: '⇧' };
  const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // On macOS, IntelliJ's ⌘ replaces Ctrl and is printed after ⌥ / ⇧.
  const printed = [...mods.filter(m => m !== 'Ctrl' && m !== 'Cmd'), ...mods.filter(m => m === 'Ctrl' || m === 'Cmd')];
  return printed.map(m => symbols[m] ?? m).join('') + parts[parts.length - 1];
}

const SEP: ActionItem = { label: '', separator: true };

/** Ongoing operation actions of Git.Branches.List (Abort Rebase, Continue Rebase, Skip Commit, …). */
export function ongoingActions(op: BranchOperation): ActionItem[] {
  switch (op) {
    case 'rebase':
      return [
        { label: translate('Abort Rebase'), icon: 'vcs/abort', action: 'ideagittool.abortOperation' },
        { label: translate('Continue Rebase'), icon: 'dvcs/resolveContinue', action: 'ideagittool.continueOperation' },
        { label: translate('Skip Commit'), icon: 'dvcs/skipCommit', action: 'ideagittool.skipCommit' },
      ];
    case 'merge':
      return [{ label: translate('Abort Merge'), icon: 'vcs/abort', action: 'ideagittool.abortOperation' }];
    case 'cherry-pick':
      return [
        { label: translate('Abort Cherry-Pick'), icon: 'vcs/abort', action: 'ideagittool.abortOperation' },
        { label: translate('Continue Cherry-Pick'), icon: 'dvcs/resolveContinue', action: 'ideagittool.continueOperation' },
      ];
    case 'revert':
      return [{ label: translate('Abort Revert'), icon: 'vcs/abort', action: 'ideagittool.abortOperation' }];
    default:
      return [];
  }
}

/**
 * Top of the branches popup: Update Project…, Commit…, Push… (Git.Experimental.Branch.Popup.Actions), then
 * Git.Branches.List: ongoing operation actions, New Branch…, Checkout Tag or Revision….
 */
export function topActionModel(ops: BranchOperation[], mac: boolean): ActionItem[] {
  const ongoing: ActionItem[] = [];
  for (const op of ops) for (const a of ongoingActions(op)) if (!ongoing.some(o => o.label === a.label)) ongoing.push(a);
  return [
    { label: translate('Update Project…'), icon: 'vcs/update', shortcut: shortcut('Ctrl+T', mac), action: 'ideagittool.updateProject' },
    { label: translate('Commit…'), icon: 'vcs/commit', shortcut: shortcut('Ctrl+K', mac), action: 'ideagittool.commit' },
    { label: translate('Push…'), icon: 'vcs/push', shortcut: shortcut('Ctrl+Shift+K', mac), action: 'ideagittool.push' },
    SEP,
    ...ongoing,
    { label: translate('New Branch…'), icon: 'general/add', shortcut: shortcut('Ctrl+Alt+N', mac), action: 'ideagittool.createBranch' },
    { label: translate('Checkout Tag or Revision…'), action: 'ideagittool.checkoutTagOrRevision' },
  ];
}

export interface RefActionOptions {
  /** Current branch of the repository (undefined when HEAD is detached). */
  currentBranch?: string;
  /** The branch is checked out in another worktree. */
  otherWorktree?: boolean;
  /** Synchronous branch control: the actions run in every repository. */
  sync?: boolean;
  mac?: boolean;
}

/**
 * Per-ref submenu (Git.Branch group) with the labels of GitBranchPopupActions; items that do not apply
 * to the ref kind are left out, like IntelliJ hides them. `action` is a command id taking `{root, name, type}`,
 * or OPEN_WORKTREE / NEW_WORKTREE.
 */
export function refActionModel(ref: Pick<BranchRef, 'name' | 'type' | 'current' | 'upstream'>, o: RefActionOptions = {}): ActionItem[] {
  const cur = o.currentBranch;
  const current = ref.type === 'local' && !!ref.current;
  const isTag = ref.type === 'tag';
  const ns = isTag ? 'ideagittool.tag' : 'ideagittool.branch';
  const items: ActionItem[] = [];
  if (!current) items.push({ label: translate('Checkout'), action: `${ns}.checkout` });
  if (o.otherWorktree && !o.sync) items.push({ label: translate('Open Worktree…'), action: OPEN_WORKTREE });
  items.push({ label: translate("New Branch from '{0}'…", ref.name), icon: 'general/add', action: 'ideagittool.branch.newBranchFrom' });
  if (!current && !isTag && cur) items.push({ label: translate("Checkout and Rebase onto '{0}'", cur), action: 'ideagittool.branch.checkoutAndRebase' });
  if (ref.type === 'local' && !current && ref.upstream) items.push({ label: translate('Checkout and Update'), action: 'ideagittool.branch.checkoutAndUpdate' });
  if (!current && !o.otherWorktree && !o.sync) items.push({ label: translate("New Worktree from '{0}'…", ref.name), action: NEW_WORKTREE });
  items.push(SEP);
  if (!current && cur) items.push({ label: translate("Compare with '{0}'", cur), action: 'ideagittool.branch.compare' });
  items.push({ label: translate('Show Diff with Working Tree'), icon: 'vcs/diff', action: 'ideagittool.branch.showDiffWithWorkingTree' });
  items.push(SEP);
  if (!current && cur) {
    items.push({ label: translate("Rebase '{0}' onto '{1}'", cur, ref.name), action: 'ideagittool.branch.rebaseCurrentOnto' });
    items.push({ label: translate("Merge '{0}' into '{1}'", ref.name, cur), icon: 'vcs/merge', action: isTag ? 'ideagittool.tag.mergeIntoCurrent' : 'ideagittool.branch.mergeIntoCurrent' });
  }
  items.push(SEP);
  if (ref.type === 'local') {
    if (ref.upstream || current) items.push({ label: translate('Update'), icon: 'vcs/update', action: 'ideagittool.branch.update' });
    items.push({ label: translate('Push…'), icon: 'vcs/push', shortcut: shortcut('Ctrl+Shift+K', !!o.mac), action: 'ideagittool.branch.push' });
    items.push({ label: ref.upstream ? translate("Tracked Branch '{0}'…", ref.upstream) : translate('Set Tracked Branch…'), action: 'ideagittool.branch.trackRemote' });
  }
  if (ref.type === 'remote' && cur) {
    items.push({ label: translate("Pull into '{0}' Using Rebase", cur), action: 'ideagittool.branch.pullRebase' });
    items.push({ label: translate("Pull into '{0}' Using Merge", cur), action: 'ideagittool.branch.pullMerge' });
  }
  items.push(SEP);
  if (isTag) items.push({ label: translate('Push Tag'), icon: 'vcs/push', action: 'ideagittool.tag.push' });
  items.push(SEP);
  if (ref.type === 'local') items.push({ label: translate('Rename…'), shortcut: 'F2', action: 'ideagittool.branch.rename' });
  if (!current) items.push({ label: translate('Delete'), icon: 'general/delete', shortcut: o.mac ? '⌫' : 'Delete', action: `${ns}.delete` });
  return cleanSeparators(items);
}

/** Drops leading, trailing and doubled separators. */
export function cleanSeparators(items: ActionItem[]): ActionItem[] {
  const out: ActionItem[] = [];
  for (const it of items) {
    if (it.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}
