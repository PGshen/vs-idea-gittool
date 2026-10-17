import { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { anchorBelow, MenuEntry, showMenu } from './menu';
import { persist, persisted } from './rpc';

// ---------------------------------------------------------------- Tooltips

let tooltipEl: HTMLDivElement | undefined;
let tooltipTimer: number | undefined;

/** Global tooltip for elements with `data-tip` (and optional `data-shortcut`), like IntelliJ's HelpTooltip. */
function installTooltips() {
  document.addEventListener('mouseover', e => {
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    clearTimeout(tooltipTimer);
    tooltipEl?.remove();
    tooltipEl = undefined;
    if (!t) return;
    tooltipTimer = window.setTimeout(() => {
      if (!t.isConnected || !t.matches(':hover')) return;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'tooltip';
      tooltipEl.textContent = t.dataset.tip!;
      if (t.dataset.shortcut) {
        const s = document.createElement('span');
        s.className = 'shortcut';
        s.textContent = t.dataset.shortcut;
        tooltipEl.appendChild(s);
      }
      document.body.appendChild(tooltipEl);
      const r = t.getBoundingClientRect();
      let x = r.left;
      let y = r.bottom + 6;
      if (x + tooltipEl.offsetWidth > window.innerWidth - 4) x = window.innerWidth - tooltipEl.offsetWidth - 4;
      if (y + tooltipEl.offsetHeight > window.innerHeight - 4) y = r.top - tooltipEl.offsetHeight - 6;
      tooltipEl.style.left = `${Math.max(4, x)}px`;
      tooltipEl.style.top = `${y}px`;
    }, 600);
  });
  document.addEventListener('mousedown', () => {
    clearTimeout(tooltipTimer);
    tooltipEl?.remove();
    tooltipEl = undefined;
  });
}
installTooltips();

// ---------------------------------------------------------------- Toolbar

export interface ActionButtonProps {
  icon: string;
  tip: string;
  shortcut?: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  toggled?: boolean;
  /** Shows the small dropdown mark and opens this menu on click. */
  menu?: () => MenuEntry[];
}

export function ActionButton({ icon, tip, shortcut, onClick, disabled, toggled, menu }: ActionButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      ref={ref}
      class={`action-button ${toggled ? 'toggled' : ''} ${pressed ? 'pressed' : ''}`}
      data-tip={tip}
      data-shortcut={shortcut}
      disabled={disabled}
      aria-label={tip}
      onClick={e => {
        if (menu) {
          setPressed(true);
          showMenu(menu(), anchorBelow(ref.current!), { onClose: () => setPressed(false) });
        } else onClick?.(e);
      }}
    >
      <Icon name={icon} />
      {menu && <span class="dropdown-mark" />}
    </button>
  );
}

export function Toolbar({ children, vertical, class: cls, style }: { children: ComponentChildren; vertical?: boolean; class?: string; style?: JSX.CSSProperties }) {
  return (
    <div class={`toolbar ${vertical ? 'vertical' : ''} ${cls ?? ''}`} style={style}>
      {children}
    </div>
  );
}

export function Separator() {
  return <span class="toolbar-separator" />;
}

export function Spacer() {
  return <span class="spacer" />;
}

// ---------------------------------------------------------------- Inputs

export function Checkbox({ checked, onChange, label, disabled, tip }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; disabled?: boolean; tip?: string }) {
  return (
    <label class={`checkbox ${disabled ? 'disabled' : ''}`} data-tip={tip}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Radio({ checked, onChange, label, name, disabled }: { checked: boolean; onChange: () => void; label: ComponentChildren; name: string; disabled?: boolean }) {
  return (
    <label class="radio">
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={() => onChange()} />
      <span>{label}</span>
    </label>
  );
}

export function Button({ children, primary, onClick, disabled, tip, style }: { children: ComponentChildren; primary?: boolean; onClick?: () => void; disabled?: boolean; tip?: string; style?: JSX.CSSProperties }) {
  return (
    <button class={`btn ${primary ? 'primary' : ''}`} onClick={onClick} disabled={disabled} data-tip={tip} style={style}>
      {children}
    </button>
  );
}

/** Button with a dropdown arrow part, like IntelliJ's JBOptionButton ("Commit ▾", "Push ▾"). */
export function SplitButton({ children, primary, onClick, disabled, menu }: { children: ComponentChildren; primary?: boolean; onClick: () => void; disabled?: boolean; menu: () => MenuEntry[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <span class="btn-split">
      <button class={`btn ${primary ? 'primary' : ''}`} onClick={onClick} disabled={disabled}>
        {children}
      </button>
      <button ref={ref} class={`btn arrow ${primary ? 'primary' : ''}`} disabled={disabled} onClick={() => showMenu(menu(), anchorBelow(ref.current!))}>
        <Icon name="general/chevronDown" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- Split pane

export function Split({
  children,
  vertical,
  persistKey,
  initial,
  min = 60,
  second = false,
}: {
  children: [ComponentChildren, ComponentChildren];
  vertical?: boolean;
  persistKey: string;
  /** Initial size in px of the first pane (or the second when `second`). */
  initial: number;
  min?: number;
  /** Size applies to the second pane instead of the first. */
  second?: boolean;
}) {
  const [size, setSize] = useState<number>(() => persisted(`split:${persistKey}`, initial));
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: MouseEvent) => {
    e.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const total = vertical ? rect.height : rect.width;
    const move = (ev: MouseEvent) => {
      const pos = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      const s = second ? total - pos : pos;
      setSize(Math.max(min, Math.min(total - min, s)));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setSize(s => {
        persist(`split:${persistKey}`, s);
        return s;
      });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const fixed: JSX.CSSProperties = vertical ? { height: `${size}px`, flex: 'none' } : { width: `${size}px`, flex: 'none' };
  const fill: JSX.CSSProperties = { flex: 1 };
  return (
    <div class={`split ${vertical ? 'vertical' : ''}`} ref={ref}>
      <div class="pane" style={second ? fill : fixed}>
        {children[0]}
      </div>
      <div class="splitter" onMouseDown={onDown} />
      <div class="pane" style={second ? fixed : fill}>
        {children[1]}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Tree

export interface TreeNode<T = any> {
  key: string;
  label: ComponentChildren;
  /** Plain text used by speed search and sorting. */
  text?: string;
  icon?: string;
  /** Extra element before the label (e.g. colored icon). */
  prefix?: ComponentChildren;
  hint?: ComponentChildren;
  /** CSS class for the label, e.g. "st-M". */
  labelClass?: string;
  children?: TreeNode<T>[];
  data?: T;
  /** Shows a checkbox. */
  checkable?: boolean;
  bold?: boolean;
  tip?: string;
}

export type CheckState = 'on' | 'off' | 'mixed';

interface FlatRow<T> {
  node: TreeNode<T>;
  depth: number;
}

const ROW = 24;

export interface TreeProps<T> {
  nodes: TreeNode<T>[];
  expanded: Set<string>;
  onExpandedChange: (expanded: Set<string>) => void;
  selection: Set<string>;
  onSelectionChange: (selection: Set<string>, lead?: TreeNode<T>) => void;
  checkState?: (node: TreeNode<T>) => CheckState;
  onCheck?: (node: TreeNode<T>, value: boolean) => void;
  /** Double click or Enter. */
  onOpen?: (node: TreeNode<T>) => void;
  onContextMenu?: (e: MouseEvent, nodes: TreeNode<T>[]) => void;
  onKeyDown?: (e: KeyboardEvent, selected: TreeNode<T>[]) => boolean | void;
  emptyText?: ComponentChildren;
  class?: string;
  /** Drag and drop of file nodes, e.g. between changelists. */
  draggable?: boolean;
  onDrop?: (target: TreeNode<T>, keys: string[]) => void;
  indent?: number;
}

/** Collects all nodes in the subtree, depth first. */
export function walkTree<T>(nodes: TreeNode<T>[], fn: (n: TreeNode<T>) => void) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walkTree(n.children, fn);
  }
}

/**
 * Virtualized tree with IntelliJ behavior: chevrons, multi-selection with Shift/Ctrl,
 * checkboxes with tri-state parents, speed search by typing, keyboard navigation.
 */
export function Tree<T>(props: TreeProps<T>) {
  const { nodes, expanded, selection, indent = 16 } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [lead, setLead] = useState<string | undefined>();
  const [anchorKey, setAnchorKey] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [dropKey, setDropKey] = useState<string | undefined>();

  const rows = useMemo(() => {
    const out: FlatRow<T>[] = [];
    const walk = (list: TreeNode<T>[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (n.children && expanded.has(n.key)) walk(n.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }, [nodes, expanded]);

  const indexOf = useCallback((key?: string) => (key === undefined ? -1 : rows.findIndex(r => r.node.key === key)), [rows]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const scrollToIndex = (i: number) => {
    const el = ref.current!;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  };

  const selectIndex = (i: number, e?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (i < 0 || i >= rows.length) return;
    const key = rows[i].node.key;
    let next: Set<string>;
    if (e?.shiftKey && anchorKey !== undefined) {
      const a = indexOf(anchorKey);
      next = new Set(e.ctrlKey || e.metaKey ? selection : []);
      for (let j = Math.min(a, i); j <= Math.max(a, i); j++) next.add(rows[j].node.key);
    } else if (e && (e.ctrlKey || e.metaKey)) {
      next = new Set(selection);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setAnchorKey(key);
    } else {
      next = new Set([key]);
      setAnchorKey(key);
    }
    setLead(key);
    props.onSelectionChange(next, rows[i].node);
    scrollToIndex(i);
  };

  const toggle = (n: TreeNode<T>, open?: boolean) => {
    const next = new Set(expanded);
    const isOpen = next.has(n.key);
    if (open ?? !isOpen) next.add(n.key);
    else next.delete(n.key);
    props.onExpandedChange(next);
  };

  const selectedNodes = () => rows.filter(r => selection.has(r.node.key)).map(r => r.node);

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.onKeyDown?.(e, selectedNodes())) {
      e.preventDefault();
      return;
    }
    const i = indexOf(lead);
    const row = rows[i];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectIndex(Math.min(rows.length - 1, i + 1), e);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectIndex(Math.max(0, i - 1), e);
        break;
      case 'Home':
        selectIndex(0, e);
        break;
      case 'End':
        selectIndex(rows.length - 1, e);
        break;
      case 'PageDown':
        selectIndex(Math.min(rows.length - 1, i + Math.floor(height / ROW)), e);
        break;
      case 'PageUp':
        selectIndex(Math.max(0, i - Math.floor(height / ROW)), e);
        break;
      case 'ArrowRight':
        if (row?.node.children) {
          if (!expanded.has(row.node.key)) toggle(row.node, true);
          else selectIndex(i + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.node.children && expanded.has(row.node.key)) toggle(row.node, false);
        else {
          for (let j = i - 1; j >= 0; j--) {
            if (rows[j].depth < row.depth) {
              selectIndex(j);
              break;
            }
          }
        }
        break;
      case 'Enter':
        if (row) {
          if (row.node.children && !props.onOpen) toggle(row.node);
          else props.onOpen?.(row.node);
        }
        break;
      case ' ':
        if (props.onCheck && props.checkState) {
          e.preventDefault();
          const sel = selectedNodes().filter(n => n.checkable);
          if (sel.length) {
            const value = props.checkState(sel[0]) !== 'on';
            sel.forEach(n => props.onCheck!(n, value));
          }
        }
        break;
      case 'Escape':
        if (search) setSearch('');
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          props.onSelectionChange(new Set(rows.map(r => r.node.key)));
          break;
        }
      // fallthrough to speed search
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const s = search + e.key;
          setSearch(s);
          const start = Math.max(0, i);
          for (let n = 0; n < rows.length; n++) {
            const j = (start + n) % rows.length;
            const text = rows[j].node.text ?? (typeof rows[j].node.label === 'string' ? (rows[j].node.label as string) : '');
            if (text.toLowerCase().includes(s.toLowerCase())) {
              selectIndex(j);
              break;
            }
          }
        } else if (e.key === 'Backspace' && search) setSearch(search.slice(0, -1));
    }
  };

  useEffect(() => {
    if (!search) return;
    const t = setTimeout(() => setSearch(''), 3000);
    return () => clearTimeout(t);
  }, [search]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 5);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 5);

  return (
    <div
      class={`tree ${props.class ?? ''}`}
      ref={ref}
      tabIndex={0}
      onScroll={e => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}
      onKeyDown={onKeyDown}
      onContextMenu={e => {
        if (e.target === ref.current) {
          e.preventDefault();
          props.onContextMenu?.(e, []);
        }
      }}
    >
      {rows.length === 0 && props.emptyText && <div class="empty-text">{props.emptyText}</div>}
      <div style={{ height: `${rows.length * ROW + 4}px`, position: 'relative' }}>
        {rows.slice(first, last).map((r, k) => {
          const i = first + k;
          const n = r.node;
          const check = n.checkable && props.checkState ? props.checkState(n) : undefined;
          return (
            <div
              key={n.key}
              class={`tree-row ${selection.has(n.key) ? 'selected' : ''} ${dropKey === n.key ? 'drop-target' : ''}`}
              style={{ position: 'absolute', top: `${i * ROW + 2}px`, left: 0, right: 0, paddingLeft: `${r.depth * indent + 2}px` }}
              data-tip={n.tip}
              draggable={props.draggable}
              onDragStart={e => {
                const keys = selection.has(n.key) ? [...selection] : [n.key];
                e.dataTransfer!.setData('application/x-tree-keys', JSON.stringify(keys));
              }}
              onDragOver={e => {
                if (props.onDrop) {
                  e.preventDefault();
                  setDropKey(n.key);
                }
              }}
              onDragLeave={() => setDropKey(undefined)}
              onDrop={e => {
                e.preventDefault();
                setDropKey(undefined);
                const data = e.dataTransfer?.getData('application/x-tree-keys');
                if (data) props.onDrop?.(n, JSON.parse(data));
              }}
              onMouseDown={e => {
                if (e.button === 2 && selection.has(n.key)) return;
                if ((e.target as Element).closest('.chevron,.tree-check')) return;
                selectIndex(i, e);
              }}
              onDblClick={e => {
                if ((e.target as Element).closest('.chevron,.tree-check')) return;
                if (props.onOpen && !n.children) props.onOpen(n);
                else if (n.children) toggle(n);
                else props.onOpen?.(n);
              }}
              onContextMenu={e => {
                e.preventDefault();
                const sel = selection.has(n.key) ? selectedNodes() : [n];
                if (!selection.has(n.key)) selectIndex(i);
                props.onContextMenu?.(e, sel);
              }}
            >
              <span class="chevron" onClick={() => n.children && toggle(n)}>
                {n.children && n.children.length > 0 && <Icon name={expanded.has(n.key) ? 'general/chevronDown' : 'general/chevronRight'} />}
              </span>
              {check !== undefined && (
                <input
                  type="checkbox"
                  class={`tree-check ${check === 'mixed' ? 'indeterminate' : ''}`}
                  checked={check === 'on'}
                  tabIndex={-1}
                  onClick={e => {
                    e.stopPropagation();
                    props.onCheck!(n, check !== 'on');
                  }}
                />
              )}
              {n.prefix}
              {n.icon && <Icon name={n.icon} />}
              <span class={`label ${n.labelClass ?? ''}`} style={n.bold ? { fontWeight: 600 } : undefined}>
                {n.label}
              </span>
              {n.hint !== undefined && <span class="hint">{n.hint}</span>}
            </div>
          );
        })}
      </div>
      {search && <div class="speed-search">{search}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Change tree helpers

export interface FileLike {
  path: string;
  root?: string;
}

/**
 * Groups files into a directory tree with IntelliJ's compaction of single-child directories
 * ("src/org/jetbrains/intellij/build 1 file").
 */
export function buildDirectoryTree<F extends FileLike>(
  files: F[],
  makeFileNode: (f: F) => TreeNode,
  keyPrefix: string,
  opts: { flat?: boolean; showCounts?: boolean } = {},
): TreeNode[] {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (opts.flat) return sorted.map(makeFileNode);
  interface Dir {
    name: string;
    dirs: Map<string, Dir>;
    files: F[];
  }
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of sorted) {
    const parts = f.path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = { name: p, dirs: new Map(), files: [] }));
      d = next;
    }
    d.files.push(f);
  }
  const count = (d: Dir): number => d.files.length + [...d.dirs.values()].reduce((s, x) => s + count(x), 0);
  const toNodes = (d: Dir, prefix: string): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let name = sub.name;
      let cur = sub;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        cur = [...cur.dirs.values()][0];
        name += '/' + cur.name;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      const n = count(cur);
      out.push({
        key: `${keyPrefix}dir:${path}`,
        label: name,
        text: name,
        icon: 'nodes/folder',
        hint: opts.showCounts === false ? undefined : `${n} ${n === 1 ? 'file' : 'files'}`,
        children: toNodes(cur, path),
        checkable: true,
        data: { dir: path },
      });
    }
    for (const f of cur_files(d)) out.push(makeFileNode(f));
    return out;
  };
  const cur_files = (d: Dir) => d.files;
  return toNodes(root, '');
}

/** All leaf keys below a node. */
export function leafKeys(n: TreeNode): string[] {
  if (!n.children) return [n.key];
  const out: string[] = [];
  walkTree(n.children, c => {
    if (!c.children) out.push(c.key);
  });
  return out;
}

export function useForceUpdate() {
  const [, set] = useState(0);
  return () => set(x => x + 1);
}

export function basename(p: string) {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
