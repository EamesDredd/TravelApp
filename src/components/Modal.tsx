import { useEffect, useId, type ReactNode } from 'react';

/** Open modals, innermost last, so Escape only closes the top one. */
const stack: string[] = [];

export function Modal(props: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Extra buttons placed left of the close button. */
  actions?: ReactNode;
}) {
  const { onClose } = props;
  const id = useId();
  useEffect(() => {
    stack.push(id);
    return () => {
      stack.splice(stack.indexOf(id), 1);
    };
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === id) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${props.wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="sheet-grip" aria-hidden />
        <header className="sheet-head">
          <div className="sheet-title">{props.title}</div>
          {props.actions}
          <button className="icon-btn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </header>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <footer className="sheet-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}
