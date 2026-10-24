import { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from '../../../lib/icons';
import { t } from '../../../lib/l10n';
import { anchorBelow, closePopup, showMenu, showPopup } from '../../../lib/menu';

export interface ComboItem {
  value: string;
  label?: string;
  icon?: string;
  hint?: string;
  /** Group title shown as a separator before this item. */
  group?: string;
}

/**
 * Editable combo box with a completion popup, like IntelliJ's branch fields (TextFieldWithCompletion + dropdown arrow).
 */
export function ComboField({
  value,
  onChange,
  items,
  placeholder,
  error,
  autofocus,
  width,
  editable = true,
}: {
  value: string;
  onChange: (v: string) => void;
  items: ComboItem[];
  placeholder?: string;
  error?: boolean;
  autofocus?: boolean;
  width?: number | string;
  editable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const f = value.toLowerCase();
    const exact = items.some(i => i.value === value);
    return !editable || exact || !f ? items : items.filter(i => i.value.toLowerCase().includes(f));
  }, [items, value, editable]);

  const openPopup = (list = filtered) => {
    if (!ref.current) return;
    setOpen(true);
    showPopup(
      close => (
        <ComboList
          items={list}
          current={value}
          width={ref.current!.offsetWidth}
          onPick={v => {
            close();
            onChange(v);
            inputRef.current?.focus();
          }}
        />
      ),
      anchorBelow(ref.current),
      { onClose: () => setOpen(false), class: 'combo-popup' },
    );
  };

  useEffect(() => {
    if (open) {
      closePopup();
      if (filtered.length) openPopup(filtered);
    }
  }, [filtered]);

  return (
    <div class={`combo-field ${error ? 'error' : ''}`} ref={ref} style={{ width: typeof width === 'number' ? `${width}px` : width }}>
      <input
        ref={inputRef}
        class="combo-input"
        value={value}
        readOnly={!editable}
        placeholder={placeholder}
        autofocus={autofocus}
        spellcheck={false}
        onInput={e => {
          onChange((e.currentTarget as HTMLInputElement).value);
          if (!open) setTimeout(() => openPopup(), 0);
        }}
        onClick={() => !editable && (open ? closePopup() : openPopup(items))}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openPopup(items);
          }
        }}
      />
      <button class="combo-arrow" tabIndex={-1} onMouseDown={e => e.preventDefault()} onClick={() => (open ? closePopup() : openPopup(items))}>
        <Icon name="general/chevronDown" />
      </button>
    </div>
  );
}

function ComboList({ items, current, onPick, width }: { items: ComboItem[]; current: string; onPick: (v: string) => void; width: number }) {
  const [active, setActive] = useState(Math.max(0, items.findIndex(i => i.value === current)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(a => Math.min(items.length - 1, a + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(a => Math.max(0, a - 1));
      } else if (e.key === 'Enter' && items[active]) {
        e.preventDefault();
        e.stopPropagation();
        onPick(items[active].value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, items]);
  useEffect(() => {
    document.querySelector('.combo-popup .menu-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (items.length === 0) return <div class="menu-item disabled" style={{ minWidth: `${width - 2}px` }}>{t('No branches')}</div>;
  return (
    <div style={{ minWidth: `${width - 2}px`, maxHeight: '300px' }}>
      {items.map((it, i) => (
        <>
          {it.group && (i === 0 || items[i - 1].group !== it.group) && <div class="menu-separator-text">{it.group}</div>}
          <div class={`menu-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => onPick(it.value)}>
            {it.icon && (
              <span class="menu-icon">
                <Icon name={it.icon} />
              </span>
            )}
            <span class="menu-text">{it.label ?? it.value}</span>
            {it.hint && <span class="menu-shortcut">{it.hint}</span>}
          </div>
        </>
      ))}
    </div>
  );
}

export interface OptionDef {
  id: string;
  flag: string;
  description: string;
  /** Options that cannot be combined with this one. */
  excludes?: string[];
}

/**
 * "Modify options ▾" link + chips of the selected options (GitMergeDialog / GitPullDialog / GitRebaseDialog).
 */
export function OptionsLink({ title, options, selected, onChange }: { title: string; options: OptionDef[]; selected: string[]; onChange: (s: string[]) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter(s => s !== id));
    else {
      const def = options.find(o => o.id === id)!;
      onChange([...selected.filter(s => !(def.excludes ?? []).includes(s) && !(options.find(o => o.id === s)?.excludes ?? []).includes(id)), id]);
    }
  };
  return (
    <span
      ref={ref}
      class="link modify-options"
      onClick={() =>
        showMenu(
          options.map(o => {
            const blocked = !selected.includes(o.id) && selected.some(s => (options.find(x => x.id === s)?.excludes ?? []).includes(o.id));
            return { label: o.flag, hint: o.description, checked: selected.includes(o.id), disabled: blocked, action: () => toggle(o.id) };
          }),
          anchorBelow(ref.current!),
          { title, searchable: false },
        )
      }
    >
      {t('Modify options')} <Icon name="general/chevronDown" size={12} />
    </span>
  );
}

export function OptionChips({ options, selected, onRemove }: { options: OptionDef[]; selected: string[]; onRemove: (id: string) => void }) {
  if (selected.length === 0) return null;
  return (
    <div class="chips">
      {selected.map(id => {
        const o = options.find(x => x.id === id);
        return (
          <span class="chip" key={id} data-tip={o?.description}>
            {o?.flag ?? id}
            <span class="chip-close" onClick={() => onRemove(id)}>
              <Icon name="general/closeSmall" />
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function Hint({ children }: { children: ComponentChildren }) {
  return <div class="field-hint">{children}</div>;
}

/** Simple selectable list used inside dialogs. */
export function ListBox<T>({
  items,
  render,
  selected,
  onSelect,
  onDblClick,
  height,
  empty,
}: {
  items: T[];
  render: (item: T, i: number) => ComponentChildren;
  selected: number;
  onSelect: (i: number) => void;
  onDblClick?: (i: number) => void;
  height?: number | string;
  empty?: string;
}) {
  return (
    <div
      class="panel-box listbox"
      tabIndex={0}
      style={{ height: typeof height === 'number' ? `${height}px` : height, overflow: 'auto' }}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onSelect(Math.min(items.length - 1, selected + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          onSelect(Math.max(0, selected - 1));
        }
      }}
    >
      {items.length === 0 && empty && <div class="empty-text">{empty}</div>}
      {items.map((item, i) => (
        <div class={`tree-row ${i === selected ? 'selected' : ''}`} key={i} onMouseDown={() => onSelect(i)} onDblClick={() => onDblClick?.(i)}>
          {render(item, i)}
        </div>
      ))}
    </div>
  );
}

export function formatDate(sec: number) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', ' ');
  if (d.toDateString() === now.toDateString()) return t('Today {0}', time);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('Yesterday {0}', time);
  return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}, ${time}`;
}
