import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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
  children,
}: {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  children?: ReactNode;
}) {
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

export const Badge = ({ tone = 'default', children }: { tone?: 'default' | 'ok' | 'warn' | 'danger'; children: ReactNode }) => (
  <span className={`badge ${tone !== 'default' ? `badge-${tone}` : ''}`}>{children}</span>
);

export const Notice = ({ tone = 'err', children }: { tone?: 'err' | 'ok' | 'warn'; children: ReactNode }) => (
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Escape closes: a modal you can only leave with the mouse is a trap on a
  // terminal where staff are working quickly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
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
