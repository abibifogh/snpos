import { useState } from 'react';
import { Button, Modal, Notice, Empty } from './components';

/**
 * The manual, rendered.
 *
 * Deliberately dependency-free: it takes articles as a prop rather than
 * reaching for them, so the same component serves the till, the kitchen screen,
 * the customer menu and the admin preview without any of them needing to agree
 * on how visibility is decided.
 */

export interface HelpBlockLike {
  kind: 'p' | 'h' | 'steps' | 'list' | 'note';
  text?: string;
  items?: string[];
  tone?: 'info' | 'warn';
}

export interface HelpArticleLike {
  id: string;
  title: string;
  summary: string;
  area: string;
  body: HelpBlockLike[];
}

export function HelpBody({ body }: { body: HelpBlockLike[] }) {
  return (
    <>
      {body.map((b, i) => {
        if (b.kind === 'h') return <h3 key={i} style={{ margin: '1.3rem 0 0.5rem' }}>{b.text}</h3>;
        if (b.kind === 'p') return <p key={i} style={{ margin: '0 0 0.8rem' }}>{b.text}</p>;
        if (b.kind === 'list') {
          return (
            <ul key={i} style={{ margin: '0 0 0.9rem', paddingLeft: '1.2rem' }}>
              {(b.items ?? []).map((t, j) => <li key={j} style={{ marginBottom: '0.3rem' }}>{t}</li>)}
            </ul>
          );
        }
        if (b.kind === 'steps') {
          return (
            <ol key={i} style={{ margin: '0 0 0.9rem', paddingLeft: '1.2rem' }}>
              {(b.items ?? []).map((t, j) => <li key={j} style={{ marginBottom: '0.35rem' }}>{t}</li>)}
            </ol>
          );
        }
        return (
          <div key={i} style={{ margin: '0 0 0.9rem' }}>
            <Notice tone={b.tone === 'warn' ? 'warn' : 'info'}>{b.text}</Notice>
          </div>
        );
      })}
    </>
  );
}

/**
 * Contents down the side, one article at a time on the right.
 *
 * On a phone the contents collapse to a back link, because a kitchen tablet
 * held in one hand has no room for two columns and the person holding it is
 * looking for one answer, not browsing.
 */
export function HelpBook({
  articles,
  areas,
  intro,
}: {
  articles: HelpArticleLike[];
  areas: { area: string; label: string }[];
  intro?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(articles[0]?.id ?? null);
  const open = articles.find((a) => a.id === openId) ?? null;

  if (articles.length === 0) {
    return <Empty title="Nothing here yet">An admin decides which parts of the manual each job can see.</Empty>;
  }

  return (
    <div className="help-book">
      <nav className="help-contents">
        {areas
          .map((g) => ({ ...g, items: articles.filter((a) => a.area === g.area) }))
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.area}>
              <div className="help-group">{g.label}</div>
              {g.items.map((a) => (
                <button
                  key={a.id}
                  className={a.id === openId ? 'on' : ''}
                  onClick={() => setOpenId(a.id)}
                >
                  {a.title}
                </button>
              ))}
            </div>
          ))}
      </nav>

      <article className="help-article">
        {intro && openId === articles[0]?.id && <p className="dim">{intro}</p>}
        {open && (
          <>
            <h2 style={{ marginTop: 0 }}>{open.title}</h2>
            <p className="dim" style={{ marginTop: '-0.4rem' }}>{open.summary}</p>
            <HelpBody body={open.body} />
          </>
        )}
      </article>
    </div>
  );
}

/** The manual in a modal, for screens with no room for a page of their own. */
export function HelpModal({
  articles,
  areas,
  onClose,
  title = 'Help',
}: {
  articles: HelpArticleLike[];
  areas: { area: string; label: string }[];
  onClose: () => void;
  title?: string;
}) {
  return (
    <Modal title={title} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>} wide>
      <HelpBook articles={articles} areas={areas} />
    </Modal>
  );
}
