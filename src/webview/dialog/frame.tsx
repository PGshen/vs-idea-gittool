import { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from '../lib/icons';

/**
 * IntelliJ DialogWrapper look: a window with a title bar, content with 16px insets and a
 * south panel with buttons on the right (OK is the default button, Enter triggers it, Escape cancels).
 */
export function DialogFrame({
  title,
  children,
  buttons,
  left,
  width = 560,
  height,
  onCancel,
  onOk,
  okDisabled,
  error,
  resizable,
}: {
  title: string;
  children: ComponentChildren;
  /** Buttons rendered on the right of the south panel. */
  buttons: ComponentChildren;
  /** Elements on the left of the south panel (help, links). */
  left?: ComponentChildren;
  width?: number | string;
  height?: number | string;
  onCancel: () => void;
  /** Default action for Enter (Ctrl+Enter inside text areas). */
  onOk?: () => void;
  okDisabled?: boolean;
  error?: string;
  resizable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.popup')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && onOk && !okDisabled) {
        const t = e.target as HTMLElement;
        const inTextArea = t.tagName === 'TEXTAREA';
        if (t.tagName === 'BUTTON' && !t.classList.contains('primary')) return;
        if (!inTextArea || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onOk();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOk, onCancel, okDisabled]);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not([type=radio]), textarea, select, .tree');
    first?.focus();
  }, []);
  const style: JSX.CSSProperties = { width: typeof width === 'number' ? `${width}px` : width };
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;
  return (
    <div class="dialog-backdrop">
      <div class={`dialog ${resizable ? 'resizable' : ''}`} style={style} ref={ref} role="dialog" aria-label={title}>
        <div class="dialog-title">
          <span>{title}</span>
          <span class="spacer" />
          <button class="action-button" data-tip="Close" onClick={onCancel}>
            <Icon name="general/close" />
          </button>
        </div>
        <div class="dialog-content">{children}</div>
        {error && <div class="dialog-error">{error}</div>}
        <div class="dialog-south">
          <div class="dialog-south-left">{left}</div>
          <div class="dialog-buttons">{buttons}</div>
        </div>
      </div>
    </div>
  );
}

/** Form row with a right-aligned label column, like IntelliJ's Kotlin UI DSL `row("Label:") { }`. */
export function Row({ label, children, top, labelFor }: { label?: ComponentChildren; children: ComponentChildren; top?: boolean; labelFor?: string }) {
  return (
    <div class={`form-row ${top ? 'top' : ''}`}>
      {label !== undefined && (
        <label class="form-label" for={labelFor}>
          {label}
        </label>
      )}
      <div class="form-field">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="form-group">
      <div class="form-group-title">{title}</div>
      {children}
    </div>
  );
}
