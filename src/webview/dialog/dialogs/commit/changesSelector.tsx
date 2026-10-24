import { useMemo, useState } from 'preact/hooks';
import { ActionButton, Toolbar, Tree, TreeNode } from '../../../lib/components';
import { t } from '../../../lib/l10n';
import { changeKey } from '../../../../shared/commitProtocol';
import { Change } from '../../../../shared/types';
import { allGroupKeys, countText, filesOfNodes, groupFiles, makeCheckState, NodeData } from '../../../commit/changesTree';

/**
 * Changes tree with checkboxes used by commit-like dialogs (Rollback Changes, Shelve Changes, Unshelve Changes).
 */
export function ChangesSelector({
  files,
  included,
  onIncludedChange,
  groupByDirectory: initialGroup,
  keyOf = changeKey,
  rootLabel,
}: {
  files: Change[];
  included: Set<string>;
  onIncludedChange: (s: Set<string>) => void;
  groupByDirectory?: boolean;
  keyOf?: (c: Change) => string;
  rootLabel?: string;
}) {
  const [groupByDirectory, setGroupByDirectory] = useState(!!initialGroup);
  const repos = useMemo(() => [...new Set(files.map(f => f.root))].map(root => ({ root, name: root.slice(root.replace(/[\\/]+$/, '').search(/[^\\/]*$/)) })), [files]);
  const nodes = useMemo(() => {
    const children = groupFiles(files, 'sel/', { groupByDirectory, groupByRepository: true, repos, checkable: true, fileKey: keyOf });
    return [
      {
        key: 'root',
        label: rootLabel ?? t('Changes'),
        text: rootLabel ?? t('Changes'),
        hint: countText(files.length),
        checkable: true,
        children,
        data: { kind: 'changelist' },
      } as TreeNode<NodeData>,
    ];
  }, [files, groupByDirectory]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root', ...allGroupKeys(nodes)]));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const checkState = useMemo(() => makeCheckState(included, keyOf), [included, nodes]);
  return (
    <div class="panel-box" style={{ flex: 1, minHeight: '180px' }}>
      <Toolbar style={{ minHeight: '30px' }}>
        <ActionButton icon="general/expandAll" tip={t('Expand All')} onClick={() => setExpanded(new Set(['root', ...allGroupKeys(nodes)]))} />
        <ActionButton icon="general/collapseAll" tip={t('Collapse All')} onClick={() => setExpanded(new Set())} />
        <ActionButton
          icon="actions/groupByPackage"
          tip={t('Group By Directory')}
          shortcut="Ctrl+Alt+P"
          toggled={groupByDirectory}
          onClick={() => {
            setGroupByDirectory(!groupByDirectory);
            setTimeout(() => setExpanded(e => new Set([...e, ...allGroupKeys(nodes)])));
          }}
        />
        <span class="spacer" style={{ flex: 1 }} />
        <span class="secondary" style={{ paddingRight: '6px' }}>
          {t('{0} of {1} selected', included.size, countText(files.length))}
        </span>
      </Toolbar>
      <Tree<NodeData>
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={setExpanded}
        selection={selection}
        onSelectionChange={setSelection}
        checkState={checkState}
        onCheck={(n, value) => {
          const next = new Set(included);
          for (const c of filesOfNodes([n])) value ? next.add(keyOf(c)) : next.delete(keyOf(c));
          onIncludedChange(next);
        }}
      />
    </div>
  );
}
