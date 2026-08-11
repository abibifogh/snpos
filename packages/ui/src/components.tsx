import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';

/* ---- primitives -------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  loading?: boolean;
};

export function Button({ variant = 'default', size = 'md', loading, children, className = '', disabled, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' && `btn-${variant}`, size === 'sm' && 'btn-sm', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  hidden,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  /** Drops the field entirely rather than dimming it, a control that is
      visible but inert is one people keep trying to use. */
  hidden?: boolean;
  children?: ReactNode;
}) {
  if (hidden) return null;
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => {
  const { invalid, className = '', ...rest } = p;
  return <input className={`input ${invalid ? 'input-invalid' : ''} ${className}`} {...rest} />;
};

export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => {
  const { className = '', ...rest } = p;
  return <select className={`select ${className}`} {...rest} />;
};

export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => {
  const { className = '', ...rest } = p;
  return <textarea className={`textarea ${className}`} {...rest} />;
};

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

/* ---- layout ------------------------------------------------------------ */

export function Card({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          {actions}
        </header>
      )}
      <div className={pad ? 'card-pad' : undefined}>{children}</div>
    </section>
  );
}

/**
 * A card that folds.
 *
 * Built on <details> rather than on a state hook and a div. The browser already
 * knows how to open and close one, it stays open when the page is printed, the
 * heading is a real button for anybody using a keyboard or a screen reader, and
 * find-in-page reaches inside a closed one in modern browsers. Every one of
 * those is a thing a hand-rolled version silently loses.
 *
 * `summary` is what somebody reads while deciding whether to open it, the
 * setting's current value, a count, whatever answers "is what I want in here?"
 * without opening it. A row of headings that all look identical is a row
 * somebody opens one at a time until they find the right one.
 */
export function FoldCard({
  title, summary, open, children, actions,
}: {
  title: ReactNode;
  summary?: ReactNode;
  /** Open on first render. Leave off for anything most people never touch. */
  open?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <details className="card fold" open={open}>
      <summary className="card-head fold-head">
        <span className="fold-title">
          <span className="fold-caret" aria-hidden="true" />
          <h2>{title}</h2>
        </span>
        {summary !== undefined && <span className="fold-summary">{summary}</span>}
        {actions}
      </summary>
      <div className="card-pad">{children}</div>
    </details>
  );
}

export const Badge = ({ tone = 'default', children }: { tone?: 'default' | 'ok' | 'warn' | 'danger'; children: ReactNode }) => (
  <span className={`badge ${tone !== 'default' ? `badge-${tone}` : ''}`}>{children}</span>
);

export const Notice = ({ tone = 'err', children }: { tone?: 'err' | 'ok' | 'warn' | 'info'; children: ReactNode }) => (
  <div className={`notice notice-${tone}`}>{children}</div>
);

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children && <p className="small">{children}</p>}
  </div>
);

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** For content that genuinely needs the room, like the manual. */
  wide?: boolean;
}) {
  // Escape closes: a modal you can only leave with the mouse is a trap on a
  // terminal where staff are working quickly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clicking the background does NOT close.
  //
  // It used to, and it threw away everything typed. A cook recording gas money
  // with the amount, the payee and three lines filled in taps a millimetre
  // outside the panel and the whole form is gone, with no warning and nothing
  // to undo. That is not a dialog, it is a trapdoor. Escape and the ✕ are both
  // deliberate acts; a stray tap is not.
  return (
    <div className="modal-backdrop">
      <div className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <header className="card-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---- toasts ------------------------------------------------------------ */

interface Toast { id: number; message: string; tone: 'ok' | 'err'; }
const ToastCtx = createContext<(message: string, tone?: 'ok' | 'err') => void>(() => {});

export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    // Errors linger: they usually need reading, successes usually do not.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 7000 : 3000);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'err' ? 'toast-err' : ''}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * An error where the person will actually see it.
 *
 * Put at the TOP of a form, not the bottom. A customer who taps "Add to order"
 * and gets a red line below the fold has been given no reason at all, the
 * button simply appeared not to work, which is how an order gets abandoned.
 * This also scrolls itself into view when the message changes, because on a
 * phone the top of a long dish sheet is off screen too.
 */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [message]);

  if (!message) return null;
  return (
    <div ref={ref} className="form-error" role="alert" aria-live="assertive">
      <Notice>{message}</Notice>
    </div>
  );
}
