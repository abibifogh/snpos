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

/**
 * A ? beside a name, holding the note that used to sit in grey under it.
 *
 * Every switch, box and card on the admin pages came with a paragraph of
 * explanation underneath, and a page of them reads as a page of small print:
 * the controls themselves get lost. The note is still there for anybody who
 * wants it, one tap away, and out of the way of everybody who does not.
 *
 * A button, so it can be reached with Tab and read by a screen reader. Tapping
 * it inside a switch's label or a fold's heading neither flips the switch nor
 * folds the card. Escape, or a tap anywhere else, closes it.
 */
export function InfoTip({ children, label = 'What this means' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    // Escape shuts the note and nothing else: inside a modal, the same key
    // would otherwise close the modal too and lose what was typed in it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="infotip" ref={ref}>
      <button
        type="button"
        className="infotip-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
      >
        ?
      </button>
      {open && (
        <span className="infotip-pop" role="note" onClick={(e) => e.stopPropagation()}>{children}</span>
      )}
    </span>
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
      {/* The hint behind a ? beside the label; under the box only where
          there is no label to put it beside. An error is always shown. */}
      {label && <label>{label}{hint && <InfoTip label={`About ${label}`}>{hint}</InfoTip>}</label>}
      {children}
      {error ? <span className="err">{error}</span> : hint && !label ? <span className="hint">{hint}</span> : null}
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
  help,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** What switching it means, behind a ? beside the label. */
  help?: ReactNode;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}{help && <InfoTip>{help}</InfoTip>}</span>}
    </label>
  );
}

/* ---- layout ------------------------------------------------------------ */

export function Card({ title, actions, children, pad = true, help }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean;
  /** What this card is for, behind a ? beside its title. */
  help?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}{help && <InfoTip>{help}</InfoTip>}</h2>
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
  title, summary, open, children, actions, help,
}: {
  /** What this section is for, behind a ? beside its title. */
  help?: ReactNode;
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
          <h2>{title}{help && <InfoTip>{help}</InfoTip>}</h2>
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
  dismissible = true,
  help,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** A note read once rather than every time, behind a ? on the title. */
  help?: ReactNode;
  /** For content that genuinely needs the room, like the manual. */
  wide?: boolean;
  /**
   * Whether Escape and the ✕ get somebody out of here.
   *
   * True for everything that asks a question. False for the very few that set
   * a condition — a bar shift's stock count, where an admin has said the count
   * is not optional. A ✕ on one of those is not a way out of the task, it is a
   * way to record that the task was done when it was not.
   *
   * Only ever use it where the screen ITSELF offers a way forward. A modal
   * with no exit and no satisfiable action is a bricked till.
   */
  dismissible?: boolean;
}) {
  // Escape closes: a modal you can only leave with the mouse is a trap on a
  // terminal where staff are working quickly.
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dismissible]);

  /**
   * Fit inside what the keyboard has left, not inside the screen.
   *
   * A modal was sized against the window, and the window does not shrink when
   * an on-screen keyboard opens: it slides over the page. So half the form
   * ended up underneath it, Save included. On a till lying flat in landscape
   * this is not a nuisance, it is most of the screen — a keyboard takes a
   * fixed share of the height and a landscape screen has very little height
   * to start with. Somebody types an amount and can no longer see or reach the
   * button that records it.
   *
   * `visualViewport` is the part still actually visible, and it is the only
   * thing that reports the keyboard. Its height and its offset both matter:
   * the offset is how far the browser has scrolled the page up to keep the
   * cursor in view, and without it the panel is pinned to a top that is no
   * longer on screen.
   *
   * Falls back to the window where there is no such thing, which is every
   * desktop browser, where there is no keyboard to make room for anyway.
   */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      const root = document.documentElement;
      root.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
      // Cleared on the way out so a stale height cannot outlive the modal that
      // measured it.
      document.documentElement.style.removeProperty('--vv-height');
      document.documentElement.style.removeProperty('--vv-top');
    };
  }, []);

  /**
   * Keep whatever is being typed into on screen.
   *
   * The browser does this by itself for a page, and does it badly for a panel
   * that scrolls inside its own box: it will happily leave the field one line
   * below the fold. Asking directly costs nothing and is the difference
   * between typing a figure and typing a figure you cannot see.
   */
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.('.modal-body')) return;
      window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

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
          <h2>{title}{help && <InfoTip>{help}</InfoTip>}</h2>
          {dismissible && <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>}
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
    // A toast with nothing in it is worse than no toast: a box appears, the
    // person knows something happened, and they are given nothing to act on.
    // Caught here as well as at the call site, because there is no message a
    // caller could pass that makes an empty one worth showing.
    if (!message?.trim()) return;
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
