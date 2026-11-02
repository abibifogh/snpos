import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** "Michael Osei" as "MO"; one name as its first two letters. */
export const initialsOf = (name?: string | null): string => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const firstName = (name?: string | null): string => (name ?? '').trim().split(/\s+/)[0] || 'Signed in';

export interface PersonAction {
  label: string;
  onClick: () => void;
  /** The one thing this menu is for: drawn as the brand button. */
  main?: boolean;
  icon?: string;
}

/**
 * Whoever is working this screen, as a person: a face, a first name, and a
 * short menu.
 *
 * On the kitchen screen and the till alike. Each used to show the name as
 * text (an outlined pill reading "Michael · hand over", or a grey line under
 * the venue's name) with the buttons to hand over, lock or sign out
 * somewhere else on the bar. The name is what somebody looks for when they
 * want to stop being it, so the buttons live behind it.
 */
export function PersonChip({ name, detail, since, sinceWords = 'On since', actions }: {
  name?: string | null;
  /** Under the full name in the menu: their role, say. */
  detail?: ReactNode;
  /** When they took this screen. */
  since?: Date | null;
  sinceWords?: string;
  actions: PersonAction[];
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const time = since ? since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <span className="who-chip-wrap">
      <button
        type="button"
        className="who-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={name ?? undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="who-av" aria-hidden="true">{initialsOf(name)}<i /></span>
        <span className="who-chip-name">{firstName(name)}</span>
        <span className="who-caret" aria-hidden="true" />
      </button>
      {open && (
        <>
          <button type="button" className="who-scrim" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="who-pop" role="menu">
            <div className="who-me">
              <span className="who-av lg" aria-hidden="true">{initialsOf(name)}<i /></span>
              <div>
                <b>{name || 'Signed in'}</b>
                <small>{[detail, time ? `${sinceWords} ${time}` : null].filter(Boolean).map((x, i) => <span key={i}>{i > 0 ? ' · ' : ''}{x}</span>)}</small>
              </div>
            </div>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={a.main ? 'who-act main' : 'who-act'}
                onClick={() => { setOpen(false); a.onClick(); }}
              >
                {a.icon && <span aria-hidden="true">{a.icon}</span>} {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
