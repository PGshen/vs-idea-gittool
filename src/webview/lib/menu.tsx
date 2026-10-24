import { ComponentChildren, render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';
import { t } from './l10n';

export interface MenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  /** Shows a check mark (toggle actions). */
  checked?: boolean;
  /** Secondary text after the label. */
  hint?: string;
  children?: MenuEntry[];
  action?: () => void;
  separator?: undefined;
}

export interface MenuSeparator {
  separator: true;
  /** Titled separator, like "Local" / "Remote" in the branches popup. */
  label?: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface Anchor {
  x: number;
  y: number;
  /** When the popup does not fit below, it flips above `y - flipHeight`. */
  flipHeight?: number;
  alignRight?: boolean;
}

let popupHost: HTMLDivElement | undefined;
let closeCurrent: (() => void) | undefined;

function host() {
  if (!popupHost) {
    popupHost = document.createElement('div');
    popupHost.id = 'popup-host';
    document.body.appendChild(popupHost);
  }
  return popupHost;
}

export function anchorBelow(el: Element, alignRight = false): Anchor {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right : r.left, y: r.bottom + 2, flipHeight: r.height + 4, alignRight };
}

export function anchorAt(e: MouseEvent): Anchor {
  return { x: e.clientX, y: e.clientY };
}

/** Closes the open popup, if any. */
export function closePopup() {
  closeCurrent?.();
}

/**
 * Shows arbitrary popup content (filter popups, pickers). The content gets a `close` callback.
 */
export function showPopup(content: (close: () => void) => ComponentChildren, anchor: Anchor, opts: { onClose?: () => void; class?: string } = {}) {
  closeCurrent?.();
  const container = document.createElement('div');
  host().appendChild(container);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    render(null, container);
    container.remove();
    if (closeCurrent === close) closeCurrent = undefined;
    opts.onClose?.();
  };
  closeCurrent = close;
  render(
    <PopupFrame anchor={anchor} close={close} class={opts.class}>
      {content(close)}
    </PopupFrame>,
    container,
  );
  return close;
}

function PopupFrame({ anchor, close, children, class: cls }: { anchor: Anchor; close: () => void; children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => position(ref.current!, anchor), []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.popup')) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onBlur = () => close();
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('contextmenu', onDown, true);
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('contextmenu', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return (
    <div class={`popup ${cls ?? ''}`} ref={ref} tabIndex={-1}>
      {children}
    </div>
  );
}

function position(el: HTMLElement, a: Anchor) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = a.alignRight ? a.x - w : a.x;
  let y = a.y;
  if (x + w > window.innerWidth - 4) x = Math.max(4, window.innerWidth - w - 4);
  if (x < 4) x = 4;
  if (y + h > window.innerHeight - 4) {
    const above = a.y - (a.flipHeight ?? 0) - h;
    y = above >= 4 ? above : Math.max(4, window.innerHeight - h - 4);
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** Shows a popup menu (context menu / action group popup). */
export function showMenu(entries: MenuEntry[], anchor: Anchor, opts: { title?: string; searchable?: boolean; onClose?: () => void } = {}) {
  return showPopup(close => <MenuList entries={entries} close={close} title={opts.title} searchable={opts.searchable} />, anchor, { onClose: opts.onClose });
}

function isItem(e: MenuEntry): e is MenuItem {
  return !e.separator;
}

function MenuList({ entries, close, title, searchable, depth = 0 }: { entries: MenuEntry[]; close: () => void; title?: string; searchable?: boolean; depth?: number }) {
  const [active, setActive] = useState(-1);
  const [filter, setFilter] = useState('');
  const [submenu, setSubmenu] = useState<{ index: number; anchor: Anchor } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    if (!filter) return cleanSeparators(entries);
    const f = filter.toLowerCase();
    const flat: MenuEntry[] = [];
    const walk = (list: MenuEntry[]) => {
      for (const e of list) {
        if (!isItem(e)) continue;
        if (e.children) walk(e.children);
        else if (e.label.toLowerCase().includes(f)) flat.push(e);
      }
    };
    walk(entries);
    return flat;
  }, [entries, filter]);

  const selectable = (i: number) => {
    const e = visible[i];
    return e && isItem(e) && !e.disabled;
  };

  const activate = (i: number) => {
    const e = visible[i];
    if (!e || !isItem(e) || e.disabled) return;
    if (e.children) {
      const row = listRef.current?.querySelector(`[data-index="${i}"]`);
      if (row) {
        const r = row.getBoundingClientRect();
        setSubmenu({ index: i, anchor: { x: r.right + 2, y: r.top - 6, flipHeight: -r.height } });
      }
      return;
    }
    close();
    e.action?.();
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (submenu) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const dir = ev.key === 'ArrowDown' ? 1 : -1;
        let i = active;
        for (let n = 0; n < visible.length; n++) {
          i = (i + dir + visible.length) % visible.length;
          if (selectable(i)) break;
        }
        setActive(i);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        activate(active);
      } else if (ev.key === 'ArrowRight') {
        const e = visible[active];
        if (e && isItem(e) && e.children) activate(active);
      } else if (ev.key === 'ArrowLeft' && depth > 0) {
        close();
      } else if (searchable !== false && depth === 0 && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        setFilter(f => f + ev.key);
        setActive(-1);
      } else if (ev.key === 'Backspace' && filter) {
        setFilter(f => f.slice(0, -1));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, visible, submenu, filter]);

  useEffect(() => {
    if (active < 0 && filter) {
      const first = visible.findIndex((_, i) => selectable(i));
      if (first >= 0) setActive(first);
    }
  }, [visible]);

  return (
    <div ref={listRef} onMouseLeave={() => !submenu && setActive(-1)}>
      {title && <div class="menu-separator-text" style={{ paddingTop: 2 }}>{title}</div>}
      {filter && (
        <div class="menu-search">
          <Icon name="general/search" size={16} /> <span style={{ marginLeft: 6 }}>{filter}</span>
        </div>
      )}
      {visible.map((e, i) =>
        !isItem(e) ? (
          e.label ? (
            <div class="menu-separator-text" key={`s${i}`}>
              {e.label}
            </div>
          ) : (
            <div class="menu-separator" key={`s${i}`} />
          )
        ) : (
          <div
            key={i}
            data-index={i}
            class={`menu-item ${i === active || submenu?.index === i ? 'active' : ''} ${e.disabled ? 'disabled' : ''}`}
            onMouseEnter={() => {
              setActive(i);
              if (e.children && !e.disabled) activate(i);
              else setSubmenu(null);
            }}
            onClick={() => activate(i)}
          >
            <span class="menu-icon">{e.checked ? <Icon name="actions/checked" /> : e.icon ? <Icon name={e.icon} /> : null}</span>
            <span class="menu-text">
              {e.label}
              {e.hint && <span class="secondary" style={{ marginLeft: 8 }}>{e.hint}</span>}
            </span>
            {e.shortcut && <span class="menu-shortcut">{e.shortcut}</span>}
            {e.children && <Icon name="general/chevronRight" class="menu-arrow" />}
          </div>
        ),
      )}
      {visible.length === 0 && <div class="menu-item disabled">{t('Nothing found')}</div>}
      {submenu && (
        <SubmenuPopup
          anchor={submenu.anchor}
          entries={(visible[submenu.index] as MenuItem).children!}
          closeAll={close}
          closeSelf={() => setSubmenu(null)}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

function SubmenuPopup({ anchor, entries, closeAll, closeSelf, depth }: { anchor: Anchor; entries: MenuEntry[]; closeAll: () => void; closeSelf: () => void; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    position(el, anchor);
    // Flip to the left side when there is no room on the right.
    if (anchor.x + w > window.innerWidth - 4) {
      const parentLeft = anchor.x - 2 - (el.parentElement?.closest('.popup') as HTMLElement | null)!.offsetWidth;
      el.style.left = `${Math.max(4, parentLeft - w)}px`;
    }
  }, [anchor]);
  return (
    <div class="popup" ref={ref} onMouseDown={e => e.stopPropagation()}>
      <MenuList
        entries={entries}
        depth={depth}
        searchable={false}
        close={() => {
          closeSelf();
          closeAll();
        }}
      />
    </div>
  );
}

function cleanSeparators(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!isItem(e)) {
      // Drop leading separators, and collapse runs of separators into the last one.
      if (out.length === 0 && !e.label) continue;
      if (out.length && !isItem(out[out.length - 1])) out.pop();
    }
    out.push(e);
  }
  while (out.length && !isItem(out[out.length - 1])) out.pop();
  return out;
}
